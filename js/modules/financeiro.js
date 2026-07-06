/* ======================================================================
   MARTINS — modules/financeiro.js
   Tela: Financeiro

   Responsabilidades deste módulo:
   - Dashboard com faturamento diário/semanal/mensal/anual, lucro
     líquido, total em peças, total em mão de obra, despesas do mês e
     contas a pagar, além de gráficos de evolução dos últimos 6 meses.
   - Cadastro manual de despesas da oficina (aluguel, ferramentas,
     energia, água, internet, impostos, outras), com edição,
     duplicação para o mês seguinte, marcação de pago/pendente e
     exclusão.

   O lado "entrada" do dashboard NÃO tem tabela própria: é calculado
   diretamente a partir das Ordens de Serviço com status "finalizada"
   ou "entregue" (OrdensDB), somando valorTotal/peças/mão de obra por
   período. Isso garante que o Financeiro está sempre 100% sincronizado
   com as OS reais, sem duplicar dados nem exigir passos manuais.

   O lado "saída" (despesas) usa a tabela própria `despesas`
   (DespesasDB, em js/db/despesas.js).

   Sem bibliotecas externas de gráfico (o app não tem pipeline de
   build): os gráficos de evolução são SVGs simples montados à mão.

   Segue o mesmo padrão de módulo dos demais arquivos em js/modules/.
   ====================================================================== */

const FinanceiroModule = (() => {

  const NOME_TELA = 'financeiro';
  const { CATEGORIAS, CATEGORIA_LABELS, STATUS: STATUS_DESPESA, STATUS_LABELS: STATUS_DESPESA_LABELS } = DespesasDB;

  /* --------------------------------------------------------------------
     Estado interno do módulo
     -------------------------------------------------------------------- */
  const state = {
    dashboard: null,       // último resultado de calcularDashboard()
    carregandoDashboard: false,

    despesas: [],           // cache enriquecido da última listagem de despesas
    termoBuscaDespesas: '',
    filtroStatusDespesa: 'todas',   // 'todas' | 'pendente' | 'pago'
    filtroCategoriaDespesa: 'todas',
    carregandoDespesas: false,

    modalModo: null,        // 'formulario' | 'detalhe' | 'exclusao' | null
    modalDespesaId: null,
  };

  const els = {};

  // Utilitários compartilhados (ver js/core/utils.js).
  const { formatarMoeda, formatarData, escapeHtml, mostrarToast } = Utils;

  /* --------------------------------------------------------------------
     Formatação (mesmas convenções dos demais módulos)
     -------------------------------------------------------------------- */

  function dataParaInputDate(isoString) {
    const data = isoString ? new Date(isoString) : new Date();
    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const dia = String(data.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }

  function inputDateParaIso(valorInput) {
    if (!valorInput) return null;
    const [ano, mes, dia] = valorInput.split('-').map(Number);
    return new Date(ano, mes - 1, dia, 12, 0, 0).toISOString();
  }

  function formatarMesAbreviado(data) {
    return data.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
  }

  /* --------------------------------------------------------------------
     Helpers de período (dia / semana / mês / ano)
     -------------------------------------------------------------------- */
  function inicioDoDia(data) {
    return new Date(data.getFullYear(), data.getMonth(), data.getDate(), 0, 0, 0, 0);
  }
  function fimDoDia(data) {
    return new Date(data.getFullYear(), data.getMonth(), data.getDate(), 23, 59, 59, 999);
  }
  function inicioDaSemana(data) {
    const d = new Date(data);
    d.setDate(d.getDate() - d.getDay());
    return inicioDoDia(d);
  }
  function fimDaSemana(data) {
    const d = new Date(data);
    d.setDate(d.getDate() + (6 - d.getDay()));
    return fimDoDia(d);
  }
  function inicioDoMes(data) {
    return new Date(data.getFullYear(), data.getMonth(), 1, 0, 0, 0, 0);
  }
  function fimDoMes(data) {
    return new Date(data.getFullYear(), data.getMonth() + 1, 0, 23, 59, 59, 999);
  }
  function inicioDoAno(data) {
    return new Date(data.getFullYear(), 0, 1, 0, 0, 0, 0);
  }
  function fimDoAno(data) {
    return new Date(data.getFullYear(), 11, 31, 23, 59, 59, 999);
  }

  /** Devolve o intervalo equivalente ao anterior, para calcular a variação percentual dos cards. */
  function periodoAnterior(tipo, hoje) {
    if (tipo === 'dia') {
      const ontem = new Date(hoje);
      ontem.setDate(ontem.getDate() - 1);
      return { inicio: inicioDoDia(ontem), fim: fimDoDia(ontem) };
    }
    if (tipo === 'semana') {
      const semanaPassada = new Date(hoje);
      semanaPassada.setDate(semanaPassada.getDate() - 7);
      return { inicio: inicioDaSemana(semanaPassada), fim: fimDaSemana(semanaPassada) };
    }
    if (tipo === 'mes') {
      const mesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
      return { inicio: inicioDoMes(mesPassado), fim: fimDoMes(mesPassado) };
    }
    const anoPassado = new Date(hoje.getFullYear() - 1, 0, 1);
    return { inicio: inicioDoAno(anoPassado), fim: fimDoAno(anoPassado) };
  }

  /** Últimos `n` meses (mais antigo primeiro), cada um com seu intervalo completo. */
  function obterUltimosMeses(n, hoje) {
    const meses = [];
    for (let i = n - 1; i >= 0; i--) {
      const data = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      meses.push({
        label: formatarMesAbreviado(data),
        inicio: inicioDoMes(data),
        fim: fimDoMes(data),
      });
    }
    return meses;
  }

  /* --------------------------------------------------------------------
     Cálculo do faturamento a partir das Ordens de Serviço concluídas
     -------------------------------------------------------------------- */

  /**
   * Busca todas as OS finalizadas/entregues e anota a "data de receita"
   * de cada uma (o momento em que o dinheiro entrou, na prática): a
   * data de conclusão, ou a de entrega, ou — no limite — a de abertura.
   */
  async function obterOrdensConcluidas() {
    const todas = await OrdensDB.listarTodas();
    return todas
      .filter((o) => o.status === OrdensDB.STATUS.FINALIZADA || o.status === OrdensDB.STATUS.ENTREGUE)
      .map((o) => ({ ...o, dataReceita: new Date(o.dataConclusao || o.dataEntrega || o.dataAbertura) }));
  }

  function filtrarPorPeriodo(ordens, inicio, fim) {
    return ordens.filter((o) => o.dataReceita >= inicio && o.dataReceita <= fim);
  }

  function somarFaturamento(ordens) {
    return Number(ordens.reduce((soma, o) => soma + (Number(o.valorTotal) || 0), 0).toFixed(2));
  }

  function somarPecas(ordens) {
    return Number(ordens.reduce((soma, o) => soma + OrdensDB.calcularValorPecas(o), 0).toFixed(2));
  }

  function somarMaoDeObra(ordens) {
    return Number(ordens.reduce((soma, o) => soma + OrdensDB.calcularValorMaoDeObra(o), 0).toFixed(2));
  }

  /** Variação percentual entre o período atual e o anterior (null quando não dá para calcular). */
  function calcularVariacao(atual, anterior) {
    if (!anterior) return null;
    return ((atual - anterior) / anterior) * 100;
  }

  /**
   * Monta todos os números do dashboard de uma vez: os quatro cards de
   * faturamento (com variação vs período anterior), o resumo do mês
   * (lucro líquido, peças, mão de obra, despesas, contas a pagar) e a
   * série dos últimos 6 meses para os gráficos de evolução.
   */
  async function calcularDashboard() {
    const hoje = new Date();
    const [ordens, despesasTodas, pendentes] = await Promise.all([
      obterOrdensConcluidas(),
      DespesasDB.listarTodas(),
      DespesasDB.listarPendentes(),
    ]);

    const periodos = {
      dia: { inicio: inicioDoDia(hoje), fim: fimDoDia(hoje) },
      semana: { inicio: inicioDaSemana(hoje), fim: fimDaSemana(hoje) },
      mes: { inicio: inicioDoMes(hoje), fim: fimDoMes(hoje) },
      ano: { inicio: inicioDoAno(hoje), fim: fimDoAno(hoje) },
    };

    const faturamento = {};
    for (const tipo of Object.keys(periodos)) {
      const { inicio, fim } = periodos[tipo];
      const anteriorRange = periodoAnterior(tipo, hoje);
      const valor = somarFaturamento(filtrarPorPeriodo(ordens, inicio, fim));
      const valorAnterior = somarFaturamento(filtrarPorPeriodo(ordens, anteriorRange.inicio, anteriorRange.fim));
      faturamento[tipo] = { valor, variacao: calcularVariacao(valor, valorAnterior) };
    }

    const ordensDoMes = filtrarPorPeriodo(ordens, periodos.mes.inicio, periodos.mes.fim);
    const pecasMes = somarPecas(ordensDoMes);
    const maoDeObraMes = somarMaoDeObra(ordensDoMes);

    const despesasPagasMes = DespesasDB.calcularTotal(
      despesasTodas.filter((d) => {
        if (d.status !== STATUS_DESPESA.PAGO || !d.dataPagamento) return false;
        const data = new Date(d.dataPagamento);
        return data >= periodos.mes.inicio && data <= periodos.mes.fim;
      })
    );

    const lucroLiquidoMes = Number((faturamento.mes.valor - despesasPagasMes).toFixed(2));

    const totalPendente = DespesasDB.calcularTotal(pendentes);
    const vencidas = pendentes.filter(DespesasDB.estaVencida);

    const meses = obterUltimosMeses(6, hoje);
    const serieMensal = meses.map((m) => {
      const ordensDoMesRef = filtrarPorPeriodo(ordens, m.inicio, m.fim);
      const fat = somarFaturamento(ordensDoMesRef);
      const desp = DespesasDB.calcularTotal(
        despesasTodas.filter((d) => {
          if (d.status !== STATUS_DESPESA.PAGO || !d.dataPagamento) return false;
          const data = new Date(d.dataPagamento);
          return data >= m.inicio && data <= m.fim;
        })
      );
      return { label: m.label, faturamento: fat, despesas: desp, lucro: Number((fat - desp).toFixed(2)) };
    });

    return {
      faturamento,
      pecasMes,
      maoDeObraMes,
      despesasPagasMes,
      lucroLiquidoMes,
      totalPendente,
      qtdPendentes: pendentes.length,
      qtdVencidas: vencidas.length,
      serieMensal,
    };
  }

  /* --------------------------------------------------------------------
     Gráficos de evolução (SVG desenhado à mão, sem dependências)
     -------------------------------------------------------------------- */
  function montarGraficoComparativo(serieMensal) {
    const largura = 320;
    const baseY = 140;
    const alturaBarras = 110;
    const max = Math.max(1, ...serieMensal.flatMap((d) => [d.faturamento, d.despesas]));
    const n = serieMensal.length;
    const larguraGrupo = largura / n;
    const larguraBarra = larguraGrupo * 0.26;
    const gap = larguraGrupo * 0.06;

    const conteudo = serieMensal.map((d, i) => {
      const xGrupo = i * larguraGrupo;
      const alturaFat = (d.faturamento / max) * alturaBarras;
      const alturaDesp = (d.despesas / max) * alturaBarras;
      const xFat = xGrupo + larguraGrupo / 2 - larguraBarra - gap / 2;
      const xDesp = xGrupo + larguraGrupo / 2 + gap / 2;
      return `
        <rect x="${xFat.toFixed(1)}" y="${(baseY - alturaFat).toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="${alturaFat.toFixed(1)}" rx="2" class="grafico-barra-receita"></rect>
        <rect x="${xDesp.toFixed(1)}" y="${(baseY - alturaDesp).toFixed(1)}" width="${larguraBarra.toFixed(1)}" height="${alturaDesp.toFixed(1)}" rx="2" class="grafico-barra-despesa"></rect>
        <text x="${(xGrupo + larguraGrupo / 2).toFixed(1)}" y="${baseY + 16}" text-anchor="middle" class="grafico-label-mes">${d.label}</text>
      `;
    }).join('');

    return `
      <svg viewBox="0 0 ${largura} 165" class="grafico-svg" preserveAspectRatio="none" role="img" aria-label="Faturamento e despesas dos últimos 6 meses">
        <line x1="0" y1="${baseY}" x2="${largura}" y2="${baseY}" class="grafico-eixo"></line>
        ${conteudo}
      </svg>
    `;
  }

  function montarGraficoLucro(serieMensal) {
    const largura = 320;
    const zeroY = 80;
    const amplitude = 55;
    const n = serieMensal.length;
    const passoX = n > 1 ? largura / (n - 1) : 0;
    const maxAbs = Math.max(1, ...serieMensal.map((d) => Math.abs(d.lucro)));

    const pontos = serieMensal.map((d, i) => ({
      x: i * passoX,
      y: zeroY - (d.lucro / maxAbs) * amplitude,
    }));

    const pathD = pontos.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const circulos = pontos.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="grafico-ponto"></circle>`).join('');
    const labels = serieMensal.map((d, i) => `<text x="${(i * passoX).toFixed(1)}" y="155" text-anchor="middle" class="grafico-label-mes">${d.label}</text>`).join('');

    return `
      <svg viewBox="0 0 ${largura} 165" class="grafico-svg" preserveAspectRatio="none" role="img" aria-label="Lucro líquido dos últimos 6 meses">
        <line x1="0" y1="${zeroY}" x2="${largura}" y2="${zeroY}" class="grafico-eixo-zero"></line>
        <path d="${pathD}" class="grafico-linha-lucro" fill="none"></path>
        ${circulos}
        ${labels}
      </svg>
    `;
  }

  /* --------------------------------------------------------------------
     Renderização do dashboard
     -------------------------------------------------------------------- */
  function montarCardFaturamento(rotulo, dados) {
    let deltaHtml = '';
    if (dados.variacao !== null && Number.isFinite(dados.variacao)) {
      const positivo = dados.variacao >= 0;
      deltaHtml = `<span class="fin-card-delta ${positivo ? 'is-positive' : 'is-negative'}">${positivo ? '▲' : '▼'} ${Math.abs(dados.variacao).toFixed(0)}%</span>`;
    }
    return `
      <div class="fin-card">
        <span class="fin-card-label">${rotulo}</span>
        <strong class="fin-card-valor">${formatarMoeda(dados.valor)}</strong>
        ${deltaHtml}
      </div>
    `;
  }

  function renderDashboard() {
    if (!els.dashboard) return;

    if (state.carregandoDashboard || !state.dashboard) {
      els.dashboard.innerHTML = `<p class="clientes-status">Calculando indicadores...</p>`;
      return;
    }

    const d = state.dashboard;

    els.dashboard.innerHTML = `
      <div class="fin-secao">
        <h2 class="fin-secao-titulo">Faturamento</h2>
        <div class="fin-cards-grid">
          ${montarCardFaturamento('Hoje', d.faturamento.dia)}
          ${montarCardFaturamento('Esta semana', d.faturamento.semana)}
          ${montarCardFaturamento('Este mês', d.faturamento.mes)}
          ${montarCardFaturamento('Este ano', d.faturamento.ano)}
        </div>
      </div>

      <div class="fin-secao">
        <h2 class="fin-secao-titulo">Resumo do mês</h2>
        <div class="fin-cards-grid">
          <div class="fin-card fin-card-destaque">
            <span class="fin-card-label">Lucro líquido</span>
            <strong class="fin-card-valor ${d.lucroLiquidoMes < 0 ? 'is-negative' : ''}">${formatarMoeda(d.lucroLiquidoMes)}</strong>
          </div>
          <div class="fin-card">
            <span class="fin-card-label">Peças faturadas</span>
            <strong class="fin-card-valor">${formatarMoeda(d.pecasMes)}</strong>
          </div>
          <div class="fin-card">
            <span class="fin-card-label">Mão de obra recebida</span>
            <strong class="fin-card-valor">${formatarMoeda(d.maoDeObraMes)}</strong>
          </div>
          <div class="fin-card">
            <span class="fin-card-label">Despesas pagas</span>
            <strong class="fin-card-valor">${formatarMoeda(d.despesasPagasMes)}</strong>
          </div>
          <div class="fin-card fin-card-largo fin-card-clicavel" id="fin-card-contas-a-pagar">
            <span class="fin-card-label">Contas a pagar</span>
            <strong class="fin-card-valor">${formatarMoeda(d.totalPendente)}</strong>
            <span class="fin-card-sub">${d.qtdPendentes} pendente(s)${d.qtdVencidas ? ` · <span class="is-negative">${d.qtdVencidas} vencida(s)</span>` : ''}</span>
          </div>
        </div>
      </div>

      <div class="fin-secao">
        <h2 class="fin-secao-titulo">Evolução (últimos 6 meses)</h2>
        <div class="fin-grafico-card">
          <div class="fin-grafico-legenda">
            <span class="legenda-item"><span class="legenda-dot legenda-dot-receita"></span>Faturamento</span>
            <span class="legenda-item"><span class="legenda-dot legenda-dot-despesa"></span>Despesas</span>
          </div>
          ${montarGraficoComparativo(d.serieMensal)}
        </div>
        <div class="fin-grafico-card">
          <div class="fin-grafico-legenda">
            <span class="legenda-item"><span class="legenda-dot legenda-dot-lucro"></span>Lucro líquido</span>
          </div>
          ${montarGraficoLucro(d.serieMensal)}
        </div>
      </div>
    `;

    document.getElementById('fin-card-contas-a-pagar').addEventListener('click', () => {
      state.filtroStatusDespesa = 'pendente';
      const chip = els.filtrosDespesa.querySelector('[data-status="pendente"]');
      if (chip) {
        els.filtrosDespesa.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      }
      carregarDespesas();
      els.despesasSecao.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function carregarDashboard() {
    state.carregandoDashboard = true;
    renderDashboard();
    try {
      state.dashboard = await calcularDashboard();
    } catch (erro) {
      console.error('Erro ao calcular o dashboard financeiro:', erro);
      mostrarToast('Erro ao calcular os indicadores financeiros.', 'erro');
    } finally {
      state.carregandoDashboard = false;
      renderDashboard();
    }
  }

  /* --------------------------------------------------------------------
     Modal (bottom sheet), montado a partir de Utils.criarModal, com id
     próprio deste módulo.
     -------------------------------------------------------------------- */
  function montarModal() {
    const modal = Utils.criarModal('financeiro-modal-overlay');
    els.modalOverlay = modal.overlay;
    els.modalTitulo = modal.modalTitulo;
    els.modalCorpo = modal.modalCorpo;
    els.modalRodape = modal.modalRodape;
    els._fecharModalBase = modal.fechar;
    els._abrirModalBase = modal.abrir;
  }

  function abrirModal(titulo) {
    els._abrirModalBase(titulo);
  }

  function fecharModal() {
    els._fecharModalBase();
    state.modalModo = null;
    state.modalDespesaId = null;
  }

  /* --------------------------------------------------------------------
     Formulário: criar/editar despesa
     -------------------------------------------------------------------- */
  function montarOpcoesCategorias(selecionada) {
    return Object.values(CATEGORIAS)
      .map((cat) => `<option value="${cat}" ${cat === selecionada ? 'selected' : ''}>${CATEGORIA_LABELS[cat]}</option>`)
      .join('');
  }

  function abrirFormularioDespesa(despesa = null) {
    const editando = Boolean(despesa);
    state.modalModo = 'formulario';
    state.modalDespesaId = editando ? despesa.id : null;

    els.modalCorpo.innerHTML = `
      <form id="fin-form-despesa" novalidate>
        <div class="form-group">
          <label for="campo-despesa-descricao">Descrição *</label>
          <input type="text" id="campo-despesa-descricao" maxlength="120" placeholder="Ex: Aluguel do galpão" value="${escapeHtml(despesa?.descricao || '')}" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="campo-despesa-categoria">Categoria *</label>
          <select id="campo-despesa-categoria">
            ${montarOpcoesCategorias(despesa?.categoria || CATEGORIAS.OUTRAS)}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="campo-despesa-valor">Valor *</label>
            <input type="number" id="campo-despesa-valor" min="0" step="0.01" value="${despesa?.valor || ''}" inputmode="decimal">
          </div>
          <div class="form-group">
            <label for="campo-despesa-vencimento">Vencimento *</label>
            <input type="date" id="campo-despesa-vencimento" value="${dataParaInputDate(despesa?.dataVencimento)}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-checkbox-label" for="campo-despesa-paga">
            <input type="checkbox" id="campo-despesa-paga" ${despesa?.status === STATUS_DESPESA.PAGO ? 'checked' : ''}>
            Já foi paga
          </label>
        </div>
        <div class="form-group" id="grupo-despesa-data-pagamento" ${despesa?.status === STATUS_DESPESA.PAGO ? '' : 'hidden'}>
          <label for="campo-despesa-pagamento">Data do pagamento</label>
          <input type="date" id="campo-despesa-pagamento" value="${dataParaInputDate(despesa?.dataPagamento)}">
        </div>
        <div class="form-group">
          <label for="campo-despesa-observacoes">Observações <span class="form-optional">(opcional)</span></label>
          <textarea id="campo-despesa-observacoes" rows="3" maxlength="500" placeholder="Detalhes adicionais...">${escapeHtml(despesa?.observacoes || '')}</textarea>
        </div>
        <p class="form-erro" id="fin-form-despesa-erro" hidden></p>
      </form>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-form-despesa">Cancelar</button>
      <button type="submit" form="fin-form-despesa" class="btn btn-primary" id="btn-salvar-form-despesa">Salvar</button>
    `;

    const checkboxPaga = document.getElementById('campo-despesa-paga');
    const grupoDataPagamento = document.getElementById('grupo-despesa-data-pagamento');
    checkboxPaga.addEventListener('change', () => {
      grupoDataPagamento.hidden = !checkboxPaga.checked;
    });

    document.getElementById('btn-cancelar-form-despesa').addEventListener('click', fecharModal);

    const erroEl = document.getElementById('fin-form-despesa-erro');

    document.getElementById('fin-form-despesa').addEventListener('submit', async (e) => {
      e.preventDefault();
      erroEl.hidden = true;

      const paga = checkboxPaga.checked;
      const dados = {
        descricao: document.getElementById('campo-despesa-descricao').value.trim(),
        categoria: document.getElementById('campo-despesa-categoria').value,
        valor: Number(document.getElementById('campo-despesa-valor').value) || 0,
        dataVencimento: inputDateParaIso(document.getElementById('campo-despesa-vencimento').value),
        dataPagamento: paga ? inputDateParaIso(document.getElementById('campo-despesa-pagamento').value) : null,
        status: paga ? STATUS_DESPESA.PAGO : STATUS_DESPESA.PENDENTE,
        observacoes: document.getElementById('campo-despesa-observacoes').value.trim(),
      };

      const botaoSalvar = document.getElementById('btn-salvar-form-despesa');
      botaoSalvar.disabled = true;

      try {
        if (editando) {
          await DespesasDB.atualizar(despesa.id, dados);
          mostrarToast('Despesa atualizada com sucesso.');
        } else {
          await DespesasDB.criar(dados);
          mostrarToast('Despesa cadastrada com sucesso.');
        }
        fecharModal();
        await Promise.all([carregarDespesas(), carregarDashboard()]);
      } catch (erro) {
        erroEl.textContent = erro.message || 'Não foi possível salvar a despesa.';
        erroEl.hidden = false;
        botaoSalvar.disabled = false;
      }
    });

    abrirModal(editando ? 'Editar despesa' : 'Nova despesa');
  }

  /* --------------------------------------------------------------------
     Detalhe da despesa
     -------------------------------------------------------------------- */
  async function abrirDetalheDespesa(id) {
    const despesa = await DespesasDB.buscarPorId(id);
    if (!despesa) {
      mostrarToast('Esta despesa não foi encontrada.', 'erro');
      await carregarDespesas();
      return;
    }

    state.modalModo = 'detalhe';
    state.modalDespesaId = id;

    const vencida = DespesasDB.estaVencida(despesa);

    els.modalCorpo.innerHTML = `
      <div class="detalhe-os">
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Status</span>
          <span class="status-badge status-badge-${despesa.status}">${STATUS_DESPESA_LABELS[despesa.status]}${vencida ? ' · vencida' : ''}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Categoria</span>
          <span class="detalhe-valor">${CATEGORIA_LABELS[despesa.categoria] || despesa.categoria}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Valor</span>
          <span class="detalhe-valor">${formatarMoeda(despesa.valor)}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Vencimento</span>
          <span class="detalhe-valor">${formatarData(despesa.dataVencimento)}</span>
        </div>
        ${despesa.dataPagamento ? `
          <div class="detalhe-linha">
            <span class="detalhe-rotulo">Pago em</span>
            <span class="detalhe-valor">${formatarData(despesa.dataPagamento)}</span>
          </div>` : ''}
        <div class="detalhe-linha detalhe-linha-bloco">
          <span class="detalhe-rotulo">Observações</span>
          <span class="detalhe-valor">${despesa.observacoes ? escapeHtml(despesa.observacoes) : '—'}</span>
        </div>
      </div>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-alternar-status-despesa">
        ${despesa.status === STATUS_DESPESA.PAGO ? 'Marcar como pendente' : 'Marcar como paga'}
      </button>
      <button type="button" class="btn btn-secondary" id="btn-duplicar-despesa">Duplicar p/ próximo mês</button>
      <button type="button" class="btn btn-secondary" id="btn-editar-despesa">Editar</button>
      <button type="button" class="btn btn-danger" id="btn-excluir-despesa">Excluir</button>
    `;

    document.getElementById('btn-alternar-status-despesa').addEventListener('click', async () => {
      try {
        if (despesa.status === STATUS_DESPESA.PAGO) {
          await DespesasDB.marcarComoPendente(despesa.id);
          mostrarToast('Despesa marcada como pendente.');
        } else {
          await DespesasDB.marcarComoPago(despesa.id);
          mostrarToast('Despesa marcada como paga.');
        }
        await Promise.all([carregarDespesas(), carregarDashboard()]);
        await abrirDetalheDespesa(despesa.id);
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível atualizar o status.', 'erro');
      }
    });

    document.getElementById('btn-duplicar-despesa').addEventListener('click', async () => {
      const botao = document.getElementById('btn-duplicar-despesa');
      botao.disabled = true;
      try {
        const nova = await DespesasDB.duplicarParaProximoMes(despesa.id);
        mostrarToast(`Despesa duplicada para ${formatarData(nova.dataVencimento)}.`);
        fecharModal();
        await Promise.all([carregarDespesas(), carregarDashboard()]);
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível duplicar a despesa.', 'erro');
        botao.disabled = false;
      }
    });

    document.getElementById('btn-editar-despesa').addEventListener('click', () => {
      fecharModal();
      abrirFormularioDespesa(despesa);
    });

    document.getElementById('btn-excluir-despesa').addEventListener('click', () => {
      abrirConfirmacaoExclusao(despesa);
    });

    abrirModal(despesa.descricao);
  }

  function abrirConfirmacaoExclusao(despesa) {
    state.modalModo = 'exclusao';

    els.modalCorpo.innerHTML = `
      <p class="confirmacao-texto">
        Tem certeza que deseja excluir a despesa <strong>${escapeHtml(despesa.descricao)}</strong> (${formatarMoeda(despesa.valor)})?
        Esta ação não pode ser desfeita.
      </p>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-exclusao-despesa">Cancelar</button>
      <button type="button" class="btn btn-danger" id="btn-confirmar-exclusao-despesa">Excluir</button>
    `;

    document.getElementById('btn-cancelar-exclusao-despesa').addEventListener('click', () => {
      fecharModal();
      abrirDetalheDespesa(despesa.id);
    });

    document.getElementById('btn-confirmar-exclusao-despesa').addEventListener('click', async () => {
      const botao = document.getElementById('btn-confirmar-exclusao-despesa');
      botao.disabled = true;
      try {
        await DespesasDB.excluir(despesa.id);
        fecharModal();
        mostrarToast('Despesa excluída.');
        await Promise.all([carregarDespesas(), carregarDashboard()]);
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível excluir a despesa.', 'erro');
        botao.disabled = false;
      }
    });

    abrirModal('Excluir despesa');
  }

  /* --------------------------------------------------------------------
     Lista de despesas (com busca e filtros)
     -------------------------------------------------------------------- */
  function renderListaDespesas() {
    if (!els.listaDespesas) return;

    if (state.carregandoDespesas) {
      els.listaDespesas.innerHTML = `<p class="clientes-status">Carregando despesas...</p>`;
      return;
    }

    if (!state.despesas.length) {
      const mensagem = (state.termoBuscaDespesas || state.filtroStatusDespesa !== 'todas' || state.filtroCategoriaDespesa !== 'todas')
        ? 'Nenhuma despesa encontrada para esse filtro.'
        : 'Nenhuma despesa cadastrada ainda. Toque em “+” para começar.';

      els.listaDespesas.innerHTML = `
        <div class="empty-state">
          <h2>Nada por aqui</h2>
          <p>${mensagem}</p>
        </div>
      `;
      return;
    }

    els.listaDespesas.innerHTML = state.despesas.map((despesa) => {
      const vencida = DespesasDB.estaVencida(despesa);
      return `
        <article class="despesa-card" data-id="${despesa.id}" role="button" tabindex="0">
          <div class="despesa-card-top">
            <span class="despesa-categoria">${CATEGORIA_LABELS[despesa.categoria] || despesa.categoria}</span>
            <span class="status-badge status-badge-${despesa.status}">${STATUS_DESPESA_LABELS[despesa.status]}</span>
          </div>
          <h3 class="despesa-descricao">${escapeHtml(despesa.descricao)}</h3>
          <div class="despesa-card-bottom">
            <span class="despesa-data ${vencida ? 'is-negative' : ''}">${vencida ? 'Venceu em ' : 'Vence em '}${formatarData(despesa.dataVencimento)}</span>
            <span class="despesa-valor">${formatarMoeda(despesa.valor)}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  async function carregarDespesas() {
    state.carregandoDespesas = true;
    renderListaDespesas();

    try {
      let lista = await DespesasDB.listarTodas();

      if (state.filtroStatusDespesa !== 'todas') {
        lista = lista.filter((d) => d.status === state.filtroStatusDespesa);
      }
      if (state.filtroCategoriaDespesa !== 'todas') {
        lista = lista.filter((d) => d.categoria === state.filtroCategoriaDespesa);
      }

      const alvo = state.termoBuscaDespesas.trim().toLowerCase();
      if (alvo) {
        lista = lista.filter((d) => d.descricao.toLowerCase().includes(alvo));
      }

      state.despesas = lista;
    } catch (erro) {
      console.error('Erro ao carregar despesas:', erro);
      state.despesas = [];
      mostrarToast('Erro ao carregar a lista de despesas.', 'erro');
    } finally {
      state.carregandoDespesas = false;
      renderListaDespesas();
    }
  }

  /* --------------------------------------------------------------------
     Montagem da tela (uma vez) e eventos
     -------------------------------------------------------------------- */
  function renderShell() {
    const root = document.getElementById('view-financeiro');
    root.innerHTML = `
      <div class="fin-view">
        <div id="fin-dashboard"></div>

        <div class="fin-secao" id="fin-secao-despesas">
          <h2 class="fin-secao-titulo">Despesas</h2>
          <div class="view-toolbar">
            <div class="search-field">
              <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="7"/>
                <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
              </svg>
              <input type="search" id="fin-busca-despesas" placeholder="Buscar despesa por descrição" autocomplete="off">
            </div>
            <div class="chip-row" id="fin-filtros-despesas">
              <button type="button" class="chip is-active" data-status="todas">Todas</button>
              <button type="button" class="chip" data-status="${STATUS_DESPESA.PENDENTE}">Pendentes</button>
              <button type="button" class="chip" data-status="${STATUS_DESPESA.PAGO}">Pagas</button>
            </div>
            <div class="form-group fin-select-categoria">
              <select id="fin-filtro-categoria">
                <option value="todas">Todas as categorias</option>
                ${montarOpcoesCategorias(null).replace('selected', '')}
              </select>
            </div>
          </div>
          <div class="despesas-lista" id="fin-lista-despesas"></div>
        </div>
      </div>
      <button type="button" class="fab" id="fin-fab" aria-label="Nova despesa">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    els.dashboard = document.getElementById('fin-dashboard');
    els.despesasSecao = document.getElementById('fin-secao-despesas');
    els.listaDespesas = document.getElementById('fin-lista-despesas');
    els.buscaDespesas = document.getElementById('fin-busca-despesas');
    els.filtrosDespesa = document.getElementById('fin-filtros-despesas');
    els.filtroCategoria = document.getElementById('fin-filtro-categoria');
    els.fab = document.getElementById('fin-fab');
  }

  function bindEventos() {
    let timeoutBusca = null;
    els.buscaDespesas.addEventListener('input', () => {
      clearTimeout(timeoutBusca);
      timeoutBusca = setTimeout(() => {
        state.termoBuscaDespesas = els.buscaDespesas.value;
        carregarDespesas();
      }, 200);
    });

    els.filtrosDespesa.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      els.filtrosDespesa.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      state.filtroStatusDespesa = chip.dataset.status;
      carregarDespesas();
    });

    els.filtroCategoria.addEventListener('change', () => {
      state.filtroCategoriaDespesa = els.filtroCategoria.value;
      carregarDespesas();
    });

    els.fab.addEventListener('click', () => abrirFormularioDespesa());

    els.listaDespesas.addEventListener('click', (e) => {
      const card = e.target.closest('.despesa-card');
      if (card) {
        abrirDetalheDespesa(Number(card.dataset.id));
      }
    });
    Utils.ativarCardComTeclado(els.listaDespesas, '.despesa-card');
  }

  /* --------------------------------------------------------------------
     API pública do módulo (padrão exigido por App.modules)
     -------------------------------------------------------------------- */
  return {
    name: NOME_TELA,

    init() {
      renderShell();
      montarModal();
      bindEventos();
    },

    onNavigate() {
      carregarDashboard();
      carregarDespesas();
    },
  };
})();

App.modules.register(FinanceiroModule);
