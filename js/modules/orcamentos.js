/* ======================================================================
   MARTINS — modules/orcamentos.js
   Tela: Orçamentos

   Responsabilidades deste módulo:
   - Listar / pesquisar / filtrar orçamentos por status (usa OrcamentosDB).
   - Criar, editar, duplicar e excluir um orçamento.
   - Montar o formulário com seleção de cliente/veículo já cadastrados,
     peças, mão de obra, observações e cálculo automático do total —
     mesmo padrão visual do formulário de Ordens de Serviço, mas sem
     virar uma OS enquanto não for convertido.
   - Marcar o orçamento como Pendente, Aprovado ou Recusado.
   - Converter o orçamento em Ordem de Serviço com um clique, sem
     perder nenhuma informação (delega a cópia dos dados para
     OrcamentosDB.converterEmOrdem) e abrir a OS recém-criada.

   Segue o mesmo padrão de js/modules/ordens.js: um objeto com `name`,
   `init()` e `onNavigate()`, registrado via App.modules.register. Toda
   a interface é montada por aqui (o HTML em index.html só tem o
   contêiner vazio `#view-orcamentos`).
   ====================================================================== */

const OrcamentosModule = (() => {

  const NOME_TELA = 'orcamentos';
  const { STATUS, STATUS_LABELS } = OrcamentosDB;

  /* --------------------------------------------------------------------
     Estado interno do módulo
     -------------------------------------------------------------------- */
  const state = {
    orcamentos: [],        // cache enriquecido (com cliente/veículo) da última listagem
    termoBusca: '',
    filtroStatus: 'todos', // 'todos' | 'pendente' | 'aprovado' | 'recusado' | 'convertidos'
    carregando: false,

    clientes: [],          // cache para popular os selects do formulário
    veiculos: [],
    pecasCatalogo: [],
    maoDeObraCatalogo: [],

    formPecas: [],         // itens temporários enquanto o formulário está aberto
    formMaoDeObra: [],

    modalModo: null,       // 'detalhe' | 'formulario' | 'exclusao' | null
    modalOrcamentoId: null,
  };

  const els = {};

  // Utilitários compartilhados (ver js/core/utils.js).
  const { formatarMoeda, formatarData, escapeHtml, mostrarToast } = Utils;

  /* --------------------------------------------------------------------
     Formatação (mesmas convenções do módulo de Ordens de Serviço)
     -------------------------------------------------------------------- */

  /** Converte um ISO string para o formato aceito por <input type="date">. */
  function dataParaInputDate(isoString) {
    const data = isoString ? new Date(isoString) : new Date();
    const ano = data.getFullYear();
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const dia = String(data.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }

  /** Converte o valor de um <input type="date"> de volta para ISO, preservando o horário original quando houver. */
  function inputDateParaIso(valorInput, horaOriginalIso) {
    if (!valorInput) return null;
    const [ano, mes, dia] = valorInput.split('-').map(Number);
    const base = horaOriginalIso ? new Date(horaOriginalIso) : new Date();
    base.setFullYear(ano, mes - 1, dia);
    return base.toISOString();
  }

  function descreverVeiculo(veiculo) {
    if (!veiculo) return 'Veículo não encontrado';
    const partes = [veiculo.marca, veiculo.modelo].filter(Boolean).join(' ');
    return partes ? `${veiculo.placa} — ${partes}` : veiculo.placa;
  }

  /* --------------------------------------------------------------------
     Modal (bottom sheet), montado a partir de Utils.criarModal, com ids
     isolados deste módulo para não colidir com outros modais.
     -------------------------------------------------------------------- */
  function montarModal() {
    const modal = Utils.criarModal('orcamentos-modal-overlay');
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
    state.modalOrcamentoId = null;
  }

  /* --------------------------------------------------------------------
     Formulário: itens de peças e mão de obra (subformulários inline)
     Mesmo padrão do formulário de OS (js/modules/ordens.js), com ids
     próprios para não colidir com o modal de Ordens.
     -------------------------------------------------------------------- */
  function montarFormAddPeca() {
    const opcoesCatalogo = state.pecasCatalogo
      .map((p) => `<option value="${p.id}">${escapeHtml(p.nome)} (${formatarMoeda(p.precoVenda)})</option>`)
      .join('');

    return `
      <div class="form-group">
        <label for="orc-add-peca-catalogo">Peça do estoque <span class="form-optional">(opcional)</span></label>
        <select id="orc-add-peca-catalogo">
          <option value="">Digitar manualmente</option>
          ${opcoesCatalogo}
        </select>
      </div>
      <div class="form-group">
        <label for="orc-add-peca-descricao">Descrição</label>
        <input type="text" id="orc-add-peca-descricao" maxlength="120" placeholder="Ex: Pastilha de freio dianteira" autocomplete="off">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="orc-add-peca-marca">Marca <span class="form-optional">(opcional)</span></label>
          <input type="text" id="orc-add-peca-marca" maxlength="60" placeholder="Ex: Bosch" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="orc-add-peca-codigo">Código <span class="form-optional">(opcional)</span></label>
          <input type="text" id="orc-add-peca-codigo" maxlength="60" placeholder="Ex: BR-1234" autocomplete="off">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="orc-add-peca-qtd">Quantidade</label>
          <input type="number" id="orc-add-peca-qtd" min="1" step="1" value="1" inputmode="numeric">
        </div>
        <div class="form-group">
          <label for="orc-add-peca-valor">Valor unitário</label>
          <input type="number" id="orc-add-peca-valor" min="0" step="0.01" value="0" inputmode="decimal">
        </div>
      </div>
      <div class="form-group">
        <label for="orc-add-peca-comprada-por">Comprada por</label>
        <select id="orc-add-peca-comprada-por">
          <option value="oficina">Oficina (entra no faturamento de peças)</option>
          <option value="cliente">Cliente (não entra no faturamento)</option>
        </select>
      </div>
      <button type="button" class="btn btn-secondary btn-add-item-confirmar" id="orc-btn-confirmar-add-peca">Adicionar ao orçamento</button>
    `;
  }

  function cablearFormAddPeca() {
    const selectCatalogo = document.getElementById('orc-add-peca-catalogo');
    const inputDescricao = document.getElementById('orc-add-peca-descricao');
    const inputQtd = document.getElementById('orc-add-peca-qtd');
    const inputValor = document.getElementById('orc-add-peca-valor');

    selectCatalogo.addEventListener('change', () => {
      const peca = state.pecasCatalogo.find((p) => p.id === Number(selectCatalogo.value));
      if (peca) {
        inputDescricao.value = peca.nome;
        inputValor.value = peca.precoVenda || 0;
      }
    });

    document.getElementById('orc-btn-confirmar-add-peca').addEventListener('click', () => {
      const descricao = inputDescricao.value.trim();
      const marca = document.getElementById('orc-add-peca-marca').value.trim();
      const codigo = document.getElementById('orc-add-peca-codigo').value.trim();
      const quantidade = Number(inputQtd.value) || 0;
      const valorUnitario = Number(inputValor.value) || 0;
      const compradaPor = document.getElementById('orc-add-peca-comprada-por').value === 'cliente' ? 'cliente' : 'oficina';

      if (!descricao) {
        mostrarToast('Informe a descrição da peça.', 'erro');
        return;
      }
      if (quantidade <= 0) {
        mostrarToast('A quantidade precisa ser maior que zero.', 'erro');
        return;
      }

      const pecaId = selectCatalogo.value ? Number(selectCatalogo.value) : null;
      state.formPecas.push({
        id: OrcamentosDB.novoItemId(),
        pecaId,
        descricao,
        marca: marca || null,
        codigo: codigo || null,
        quantidade,
        valorUnitario,
        origem: pecaId ? 'catalogo' : 'manual',
        compradaPor,
      });

      document.getElementById('orc-form-add-peca').hidden = true;
      renderListaPecasForm();
    });
  }

  function montarFormAddMao() {
    const opcoesCatalogo = state.maoDeObraCatalogo
      .map((s) => `<option value="${s.id}">${escapeHtml(s.descricao)} (${formatarMoeda(s.valorPadrao)})</option>`)
      .join('');

    return `
      <div class="form-group">
        <label for="orc-add-mao-catalogo">Serviço cadastrado <span class="form-optional">(opcional)</span></label>
        <select id="orc-add-mao-catalogo">
          <option value="">Digitar manualmente</option>
          ${opcoesCatalogo}
        </select>
      </div>
      <div class="form-group">
        <label for="orc-add-mao-descricao">Descrição</label>
        <input type="text" id="orc-add-mao-descricao" maxlength="120" placeholder="Ex: Alinhamento e balanceamento" autocomplete="off">
      </div>
      <div class="form-group">
        <label for="orc-add-mao-valor">Valor</label>
        <input type="number" id="orc-add-mao-valor" min="0" step="0.01" value="0" inputmode="decimal">
      </div>
      <button type="button" class="btn btn-secondary btn-add-item-confirmar" id="orc-btn-confirmar-add-mao">Adicionar ao orçamento</button>
    `;
  }

  function cablearFormAddMao() {
    const selectCatalogo = document.getElementById('orc-add-mao-catalogo');
    const inputDescricao = document.getElementById('orc-add-mao-descricao');
    const inputValor = document.getElementById('orc-add-mao-valor');

    selectCatalogo.addEventListener('change', () => {
      const servico = state.maoDeObraCatalogo.find((s) => s.id === Number(selectCatalogo.value));
      if (servico) {
        inputDescricao.value = servico.descricao;
        inputValor.value = servico.valorPadrao || 0;
      }
    });

    document.getElementById('orc-btn-confirmar-add-mao').addEventListener('click', () => {
      const descricao = inputDescricao.value.trim();
      const valor = Number(inputValor.value) || 0;

      if (!descricao) {
        mostrarToast('Informe a descrição do serviço.', 'erro');
        return;
      }

      const maoDeObraId = selectCatalogo.value ? Number(selectCatalogo.value) : null;
      state.formMaoDeObra.push({
        id: OrcamentosDB.novoItemId(),
        maoDeObraId,
        descricao,
        valor,
        origem: maoDeObraId ? 'catalogo' : 'manual',
      });

      document.getElementById('orc-form-add-mao').hidden = true;
      renderListaMaoForm();
    });
  }

  /** Re-renderiza a listinha de peças dentro do formulário e recalcula o total. */
  function renderListaPecasForm() {
    const container = document.getElementById('orc-form-lista-pecas');
    if (!container) return;

    container.innerHTML = state.formPecas.length
      ? state.formPecas.map((item) => `
          <div class="os-item-row" data-id="${item.id}">
            <div class="os-item-info">
              <span class="os-item-descricao">
                ${escapeHtml(item.descricao)}
                ${item.compradaPor === 'cliente' ? '<span class="badge-scanner">Peça do cliente</span>' : ''}
              </span>
              ${(item.marca || item.codigo) ? `<span class="os-item-marca-codigo">${escapeHtml([item.marca, item.codigo].filter(Boolean).join(' · '))}</span>` : ''}
              <span class="os-item-detalhe">${item.quantidade} × ${formatarMoeda(item.valorUnitario)}</span>
              <select class="os-item-comprada-por" data-comprada-por-peca="${item.id}">
                <option value="oficina" ${item.compradaPor === 'cliente' ? '' : 'selected'}>Comprada pela oficina</option>
                <option value="cliente" ${item.compradaPor === 'cliente' ? 'selected' : ''}>Comprada pelo cliente</option>
              </select>
            </div>
            <div class="os-item-acoes">
              <span class="os-item-subtotal">${formatarMoeda(item.quantidade * item.valorUnitario)}</span>
              <button type="button" class="os-item-remover" data-remover-peca="${item.id}" aria-label="Remover peça">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
        `).join('')
      : '<p class="os-itens-vazio">Nenhuma peça adicionada ainda.</p>';

    container.querySelectorAll('[data-comprada-por-peca]').forEach((select) => {
      select.addEventListener('change', () => {
        const item = state.formPecas.find((p) => p.id === select.dataset.compradaPorPeca);
        if (item) {
          item.compradaPor = select.value === 'cliente' ? 'cliente' : 'oficina';
          renderListaPecasForm();
        }
      });
    });

    atualizarTotalFormulario();
  }

  /** Re-renderiza a listinha de mão de obra dentro do formulário e recalcula o total. */
  function renderListaMaoForm() {
    const container = document.getElementById('orc-form-lista-mao');
    if (!container) return;

    container.innerHTML = state.formMaoDeObra.length
      ? state.formMaoDeObra.map((item) => `
          <div class="os-item-row" data-id="${item.id}">
            <div class="os-item-info">
              <span class="os-item-descricao">${escapeHtml(item.descricao)}</span>
            </div>
            <div class="os-item-acoes">
              <span class="os-item-subtotal">${formatarMoeda(item.valor)}</span>
              <button type="button" class="os-item-remover" data-remover-mao="${item.id}" aria-label="Remover serviço">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
        `).join('')
      : '<p class="os-itens-vazio">Nenhum serviço de mão de obra adicionado ainda.</p>';

    atualizarTotalFormulario();
  }

  function atualizarTotalFormulario() {
    const totalEl = document.getElementById('orc-form-total');
    if (!totalEl) return;
    const total = OrcamentosDB.calcularValorTotal({
      pecas: state.formPecas,
      maoDeObra: state.formMaoDeObra,
    });
    totalEl.textContent = formatarMoeda(total);
  }

  /* --------------------------------------------------------------------
     Formulário: selects de cliente / veículo
     -------------------------------------------------------------------- */
  function montarOpcoesClientes(clientes, selecionadoId) {
    return clientes
      .map((c) => `<option value="${c.id}" ${c.id === selecionadoId ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`)
      .join('');
  }

  function montarOpcoesVeiculos(veiculos, clienteId, selecionadoId) {
    const filtrados = veiculos.filter((v) => v.clienteId === clienteId);
    if (!filtrados.length) {
      return '<option value="">Nenhum veículo cadastrado para este cliente</option>';
    }
    const opcoes = filtrados
      .map((v) => `<option value="${v.id}" ${v.id === selecionadoId ? 'selected' : ''}>${escapeHtml(descreverVeiculo(v))}</option>`)
      .join('');
    return `<option value="">Selecione o veículo</option>${opcoes}`;
  }

  /* --------------------------------------------------------------------
     Modal: formulário de criar/editar orçamento
     -------------------------------------------------------------------- */
  async function abrirFormulario(orcamento = null) {
    const editando = Boolean(orcamento);

    const [clientes, veiculos, pecasCatalogo, maoDeObraCatalogo] = await Promise.all([
      ClientesDB.listarTodos(),
      VeiculosDB.listarTodos(),
      PecasDB.listarTodas(),
      MaoDeObraDB.listarTodos(),
    ]);

    if (!clientes.length) {
      mostrarToast('Cadastre um cliente antes de criar um orçamento.', 'erro');
      return;
    }

    state.clientes = clientes;
    state.veiculos = veiculos;
    state.pecasCatalogo = pecasCatalogo;
    state.maoDeObraCatalogo = maoDeObraCatalogo;
    state.formPecas = editando ? orcamento.pecas.map((p) => ({ ...p })) : [];
    state.formMaoDeObra = editando ? orcamento.maoDeObra.map((m) => ({ ...m })) : [];
    state.modalModo = 'formulario';
    state.modalOrcamentoId = editando ? orcamento.id : null;

    const veiculoOptionsHtml = editando
      ? montarOpcoesVeiculos(veiculos, orcamento.clienteId, orcamento.veiculoId)
      : '<option value="">Selecione o cliente primeiro</option>';

    const avisoConvertido = editando && orcamento.convertidoEmOrdemId
      ? `<p class="orc-aviso-convertido">Este orçamento já foi convertido na <strong>OS #${orcamento.convertidoEmOrdemId}</strong>. Alterações aqui não mudam a OS já criada.</p>`
      : '';

    els.modalCorpo.innerHTML = `
      <form id="orc-form" novalidate>
        ${avisoConvertido}
        <div class="form-group">
          <label for="campo-orc-cliente">Cliente *</label>
          <select id="campo-orc-cliente">
            <option value="">Selecione o cliente</option>
            ${montarOpcoesClientes(clientes, orcamento?.clienteId)}
          </select>
        </div>
        <div class="form-group">
          <label for="campo-orc-veiculo">Veículo *</label>
          <select id="campo-orc-veiculo" ${editando ? '' : 'disabled'}>
            ${veiculoOptionsHtml}
          </select>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="campo-orc-data">Data do orçamento</label>
            <input type="date" id="campo-orc-data" value="${dataParaInputDate(orcamento?.dataCriacao)}">
          </div>
          <div class="form-group">
            <label for="campo-orc-validade">Válido até <span class="form-optional">(opcional)</span></label>
            <input type="date" id="campo-orc-validade" value="${orcamento?.validoAte ? dataParaInputDate(orcamento.validoAte) : ''}">
          </div>
        </div>

        <div class="form-group">
          <label for="campo-orc-status">Status</label>
          <select id="campo-orc-status">
            ${Object.values(STATUS).map((s) => `
              <option value="${s}" ${(orcamento?.status || STATUS.PENDENTE) === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>
            `).join('')}
          </select>
        </div>

        <div class="form-group">
          <label for="campo-orc-observacoes">Observações <span class="form-optional">(opcional)</span></label>
          <textarea id="campo-orc-observacoes" rows="4" maxlength="1000" placeholder="Ex: Diagnóstico de ruído na suspensão, revisão preventiva dos freios...">${escapeHtml(orcamento?.observacoes || '')}</textarea>
        </div>

        <div class="os-form-secao">
          <div class="os-form-secao-header">
            <h3>Peças</h3>
            <button type="button" class="btn-add-item" id="orc-btn-abrir-add-peca">+ Adicionar</button>
          </div>
          <div id="orc-form-add-peca" class="os-add-item-form" hidden></div>
          <div id="orc-form-lista-pecas" class="os-itens-lista"></div>
        </div>

        <div class="os-form-secao">
          <div class="os-form-secao-header">
            <h3>Mão de obra</h3>
            <button type="button" class="btn-add-item" id="orc-btn-abrir-add-mao">+ Adicionar</button>
          </div>
          <div id="orc-form-add-mao" class="os-add-item-form" hidden></div>
          <div id="orc-form-lista-mao" class="os-itens-lista"></div>
        </div>

        <div class="os-total-linha">
          <span>Valor total</span>
          <strong id="orc-form-total">${formatarMoeda(0)}</strong>
        </div>

        <p class="form-erro" id="orc-form-erro" hidden></p>
      </form>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-form-orc">Cancelar</button>
      <button type="submit" form="orc-form" class="btn btn-primary" id="btn-salvar-form-orc">Salvar</button>
    `;

    const erroEl = document.getElementById('orc-form-erro');

    // Cliente -> filtra o select de veículo
    document.getElementById('campo-orc-cliente').addEventListener('change', (e) => {
      const clienteId = Number(e.target.value) || null;
      const veiculoSelect = document.getElementById('campo-orc-veiculo');
      if (!clienteId) {
        veiculoSelect.innerHTML = '<option value="">Selecione o cliente primeiro</option>';
        veiculoSelect.disabled = true;
        return;
      }
      veiculoSelect.disabled = false;
      veiculoSelect.innerHTML = montarOpcoesVeiculos(state.veiculos, clienteId, null);
    });

    // Botões "+ Adicionar" de peça / mão de obra
    document.getElementById('orc-btn-abrir-add-peca').addEventListener('click', () => {
      const container = document.getElementById('orc-form-add-peca');
      const abrindo = container.hidden;
      container.hidden = !abrindo;
      if (abrindo) {
        container.innerHTML = montarFormAddPeca();
        cablearFormAddPeca();
      }
    });

    document.getElementById('orc-btn-abrir-add-mao').addEventListener('click', () => {
      const container = document.getElementById('orc-form-add-mao');
      const abrindo = container.hidden;
      container.hidden = !abrindo;
      if (abrindo) {
        container.innerHTML = montarFormAddMao();
        cablearFormAddMao();
      }
    });

    // Delegação de eventos para remover itens já adicionados
    document.getElementById('orc-form-lista-pecas').addEventListener('click', (e) => {
      const botao = e.target.closest('[data-remover-peca]');
      if (!botao) return;
      state.formPecas = state.formPecas.filter((item) => item.id !== botao.dataset.removerPeca);
      renderListaPecasForm();
    });

    document.getElementById('orc-form-lista-mao').addEventListener('click', (e) => {
      const botao = e.target.closest('[data-remover-mao]');
      if (!botao) return;
      state.formMaoDeObra = state.formMaoDeObra.filter((item) => item.id !== botao.dataset.removerMao);
      renderListaMaoForm();
    });

    renderListaPecasForm();
    renderListaMaoForm();

    document.getElementById('btn-cancelar-form-orc').addEventListener('click', fecharModal);

    document.getElementById('orc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      erroEl.hidden = true;

      const clienteId = Number(document.getElementById('campo-orc-cliente').value) || null;
      const veiculoId = Number(document.getElementById('campo-orc-veiculo').value) || null;
      const dataInput = document.getElementById('campo-orc-data').value;
      const validadeInput = document.getElementById('campo-orc-validade').value;
      const status = document.getElementById('campo-orc-status').value;
      const observacoes = document.getElementById('campo-orc-observacoes').value.trim();

      if (!clienteId) {
        erroEl.textContent = 'Selecione um cliente.';
        erroEl.hidden = false;
        return;
      }
      if (!veiculoId) {
        erroEl.textContent = 'Selecione um veículo.';
        erroEl.hidden = false;
        return;
      }

      const dados = {
        clienteId,
        veiculoId,
        status,
        dataCriacao: inputDateParaIso(dataInput, orcamento?.dataCriacao) || new Date().toISOString(),
        validoAte: inputDateParaIso(validadeInput, orcamento?.validoAte),
        observacoes,
        pecas: state.formPecas,
        maoDeObra: state.formMaoDeObra,
      };

      const botaoSalvar = document.getElementById('btn-salvar-form-orc');
      botaoSalvar.disabled = true;

      try {
        if (editando) {
          await OrcamentosDB.atualizar(orcamento.id, dados);
          mostrarToast('Orçamento atualizado com sucesso.');
        } else {
          await OrcamentosDB.criar(dados);
          mostrarToast('Orçamento criado com sucesso.');
        }
        fecharModal();
        await carregarOrcamentos();
      } catch (erro) {
        erroEl.textContent = erro.message || 'Não foi possível salvar o orçamento.';
        erroEl.hidden = false;
        botaoSalvar.disabled = false;
      }
    });

    abrirModal(editando ? `Editar Orçamento #${orcamento.id}` : 'Novo Orçamento');
  }

  /* --------------------------------------------------------------------
     Modal: detalhe do orçamento
     -------------------------------------------------------------------- */
  async function abrirDetalhe(id) {
    const orcamento = await OrcamentosDB.buscarPorId(id);
    if (!orcamento) {
      mostrarToast('Este orçamento não foi encontrado.', 'erro');
      await carregarOrcamentos();
      return;
    }

    state.modalModo = 'detalhe';
    state.modalOrcamentoId = id;

    const [cliente, veiculo] = await Promise.all([
      ClientesDB.buscarPorId(orcamento.clienteId),
      VeiculosDB.buscarPorId(orcamento.veiculoId),
    ]);

    const linhasPecas = orcamento.pecas.length
      ? orcamento.pecas.map((item) => `
          <div class="os-item-row os-item-row-leitura">
            <div class="os-item-info">
              <span class="os-item-descricao">${escapeHtml(item.descricao)}</span>
              ${(item.marca || item.codigo) ? `<span class="os-item-marca-codigo">${escapeHtml([item.marca, item.codigo].filter(Boolean).join(' · '))}</span>` : ''}
              <span class="os-item-detalhe">${item.quantidade} × ${formatarMoeda(item.valorUnitario)}</span>
            </div>
            <span class="os-item-subtotal">${formatarMoeda(item.quantidade * item.valorUnitario)}</span>
          </div>
        `).join('')
      : '<p class="os-itens-vazio">Nenhuma peça lançada.</p>';

    const linhasMao = orcamento.maoDeObra.length
      ? orcamento.maoDeObra.map((item) => `
          <div class="os-item-row os-item-row-leitura">
            <span class="os-item-descricao">${escapeHtml(item.descricao)}</span>
            <span class="os-item-subtotal">${formatarMoeda(item.valor)}</span>
          </div>
        `).join('')
      : '<p class="os-itens-vazio">Nenhum serviço de mão de obra lançado.</p>';

    const infoConvertido = orcamento.convertidoEmOrdemId ? `
      <div class="orc-convertido-info">
        <span>Convertido em <strong>OS #${orcamento.convertidoEmOrdemId}</strong> em ${formatarData(orcamento.convertidoEm)}</span>
        <button type="button" class="btn btn-secondary" id="btn-ver-os-orc">Ver OS</button>
      </div>
    ` : '';

    els.modalCorpo.innerHTML = `
      <div class="detalhe-os">
        <div class="orc-status-acoes" id="orc-status-acoes">
          ${Object.values(STATUS).map((s) => `
            <button type="button" class="orc-status-btn ${orcamento.status === s ? 'is-active' : ''}" data-status="${s}">${STATUS_LABELS[s]}</button>
          `).join('')}
        </div>

        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Cliente</span>
          <span class="detalhe-valor">${escapeHtml(cliente?.nome || 'Não encontrado')}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Veículo</span>
          <span class="detalhe-valor">${escapeHtml(descreverVeiculo(veiculo))}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Criado em</span>
          <span class="detalhe-valor">${formatarData(orcamento.dataCriacao)}</span>
        </div>
        ${orcamento.validoAte ? `
          <div class="detalhe-linha">
            <span class="detalhe-rotulo">Válido até</span>
            <span class="detalhe-valor">${formatarData(orcamento.validoAte)}</span>
          </div>` : ''}
        <div class="detalhe-linha detalhe-linha-bloco">
          <span class="detalhe-rotulo">Observações</span>
          <span class="detalhe-valor">${orcamento.observacoes ? escapeHtml(orcamento.observacoes) : '—'}</span>
        </div>

        ${infoConvertido}

        <div class="detalhe-secao">
          <h3 class="detalhe-secao-titulo">Peças</h3>
          ${linhasPecas}
        </div>
        <div class="detalhe-secao">
          <h3 class="detalhe-secao-titulo">Mão de obra</h3>
          ${linhasMao}
        </div>

        <div class="os-subtotais-linha">
          <span>Valor das peças</span>
          <span>${formatarMoeda(OrcamentosDB.calcularValorPecas(orcamento))}</span>
        </div>
        <div class="os-subtotais-linha">
          <span>Valor da mão de obra</span>
          <span>${formatarMoeda(OrcamentosDB.calcularValorMaoDeObra(orcamento))}</span>
        </div>
        <div class="os-total-linha">
          <span>Valor total</span>
          <strong>${formatarMoeda(orcamento.valorTotal)}</strong>
        </div>
      </div>
    `;

    // Botões de status rápido (Pendente / Aprovado / Recusado)
    document.getElementById('orc-status-acoes').addEventListener('click', async (e) => {
      const botao = e.target.closest('.orc-status-btn');
      if (!botao || botao.classList.contains('is-active')) return;
      try {
        await OrcamentosDB.atualizarStatus(orcamento.id, botao.dataset.status);
        await carregarOrcamentos();
        await abrirDetalhe(orcamento.id);
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível atualizar o status.', 'erro');
      }
    });

    const podeConverter = !orcamento.convertidoEmOrdemId;

    els.modalRodape.innerHTML = `
      ${podeConverter ? '<button type="button" class="btn btn-primary" id="btn-converter-orc">Converter em OS</button>' : ''}
      <button type="button" class="btn btn-secondary" id="btn-duplicar-orc">Duplicar</button>
      <button type="button" class="btn btn-secondary" id="btn-editar-orc">Editar</button>
      <button type="button" class="btn btn-danger" id="btn-excluir-orc">Excluir</button>
    `;

    if (podeConverter) {
      document.getElementById('btn-converter-orc').addEventListener('click', async () => {
        const botao = document.getElementById('btn-converter-orc');
        botao.disabled = true;
        try {
          const resultado = await OrcamentosDB.converterEmOrdem(orcamento.id);
          mostrarToast(`Orçamento convertido na OS #${resultado.ordem.id}.`);
          fecharModal();
          await carregarOrcamentos();
          if (typeof OrdensModule !== 'undefined') {
            OrdensModule.abrirDetalhePorId(resultado.ordem.id);
          }
        } catch (erro) {
          mostrarToast(erro.message || 'Não foi possível converter o orçamento em OS.', 'erro');
          botao.disabled = false;
        }
      });
    }

    const botaoVerOs = document.getElementById('btn-ver-os-orc');
    if (botaoVerOs) {
      botaoVerOs.addEventListener('click', () => {
        fecharModal();
        if (typeof OrdensModule !== 'undefined') {
          OrdensModule.abrirDetalhePorId(orcamento.convertidoEmOrdemId);
        }
      });
    }

    document.getElementById('btn-editar-orc').addEventListener('click', () => {
      fecharModal();
      abrirFormulario(orcamento);
    });

    document.getElementById('btn-excluir-orc').addEventListener('click', () => {
      abrirConfirmacaoExclusao(orcamento);
    });

    document.getElementById('btn-duplicar-orc').addEventListener('click', async () => {
      const botao = document.getElementById('btn-duplicar-orc');
      botao.disabled = true;
      try {
        const novo = await OrcamentosDB.duplicar(orcamento.id);
        mostrarToast(`Orçamento #${orcamento.id} duplicado como #${novo.id}.`);
        fecharModal();
        await carregarOrcamentos();
        await abrirFormulario(await OrcamentosDB.buscarPorId(novo.id));
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível duplicar o orçamento.', 'erro');
        botao.disabled = false;
      }
    });

    abrirModal(`Orçamento #${orcamento.id}`);
  }

  /* --------------------------------------------------------------------
     Modal: confirmação de exclusão
     -------------------------------------------------------------------- */
  function abrirConfirmacaoExclusao(orcamento) {
    state.modalModo = 'exclusao';

    els.modalCorpo.innerHTML = `
      <p class="confirmacao-texto">
        Tem certeza que deseja excluir o <strong>Orçamento #${orcamento.id}</strong>?
        ${orcamento.convertidoEmOrdemId ? `A OS #${orcamento.convertidoEmOrdemId} já gerada a partir dele <strong>não</strong> será afetada.` : ''}
        Esta ação não pode ser desfeita.
      </p>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-exclusao-orc">Cancelar</button>
      <button type="button" class="btn btn-danger" id="btn-confirmar-exclusao-orc">Excluir</button>
    `;

    document.getElementById('btn-cancelar-exclusao-orc').addEventListener('click', () => {
      fecharModal();
      abrirDetalhe(orcamento.id);
    });

    document.getElementById('btn-confirmar-exclusao-orc').addEventListener('click', async () => {
      const botao = document.getElementById('btn-confirmar-exclusao-orc');
      botao.disabled = true;
      try {
        await OrcamentosDB.excluir(orcamento.id);
        fecharModal();
        mostrarToast('Orçamento excluído.');
        await carregarOrcamentos();
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível excluir o orçamento.', 'erro');
        botao.disabled = false;
      }
    });

    abrirModal('Excluir orçamento');
  }

  /* --------------------------------------------------------------------
     Lista principal (com busca e filtro por status) — mantém o
     histórico completo de orçamentos, incluindo os já convertidos.
     -------------------------------------------------------------------- */
  function renderLista() {
    if (!els.lista) return;

    if (state.carregando) {
      els.lista.innerHTML = `<p class="clientes-status">Carregando orçamentos...</p>`;
      return;
    }

    if (!state.orcamentos.length) {
      const mensagem = (state.termoBusca || state.filtroStatus !== 'todos')
        ? 'Nenhum orçamento encontrado para esse filtro.'
        : 'Nenhum orçamento criado ainda. Toque em “+” para começar.';

      els.lista.innerHTML = `
        <div class="empty-state">
          <h2>Nada por aqui</h2>
          <p>${mensagem}</p>
        </div>
      `;
      return;
    }

    els.lista.innerHTML = state.orcamentos.map((orcamento) => `
      <article class="orc-card" data-id="${orcamento.id}" role="button" tabindex="0">
        <div class="orc-card-top">
          <span class="orc-numero">Orçamento #${orcamento.id}</span>
          <span class="status-badge status-badge-${orcamento.status}">${STATUS_LABELS[orcamento.status]}</span>
        </div>
        <h3 class="orc-cliente">${escapeHtml(orcamento.cliente?.nome || 'Cliente não encontrado')}</h3>
        <p class="orc-veiculo">${escapeHtml(descreverVeiculo(orcamento.veiculo))}</p>
        ${orcamento.convertidoEmOrdemId ? `<span class="orc-convertido-tag">Convertido em OS #${orcamento.convertidoEmOrdemId}</span>` : ''}
        <div class="orc-card-bottom">
          <span class="orc-data">${formatarData(orcamento.dataCriacao)}</span>
          <span class="orc-valor">${formatarMoeda(orcamento.valorTotal)}</span>
        </div>
      </article>
    `).join('');
  }

  async function carregarOrcamentos() {
    state.carregando = true;
    renderLista();

    try {
      const [orcamentos, clientes, veiculos] = await Promise.all([
        OrcamentosDB.listarTodos(),
        ClientesDB.listarTodos(),
        VeiculosDB.listarTodos(),
      ]);

      const clientesPorId = new Map(clientes.map((c) => [c.id, c]));
      const veiculosPorId = new Map(veiculos.map((v) => [v.id, v]));

      let enriquecidos = orcamentos.map((orcamento) => ({
        ...orcamento,
        cliente: clientesPorId.get(orcamento.clienteId) || null,
        veiculo: veiculosPorId.get(orcamento.veiculoId) || null,
      }));

      if (state.filtroStatus === 'convertidos') {
        enriquecidos = enriquecidos.filter((o) => Boolean(o.convertidoEmOrdemId));
      } else if (state.filtroStatus !== 'todos') {
        enriquecidos = enriquecidos.filter((o) => o.status === state.filtroStatus);
      }

      const alvo = state.termoBusca.trim().toLowerCase();
      if (alvo) {
        enriquecidos = enriquecidos.filter((o) => {
          const nomeCliente = (o.cliente?.nome || '').toLowerCase();
          const placa = (o.veiculo?.placa || '').toLowerCase();
          const marcaModelo = [o.veiculo?.marca, o.veiculo?.modelo].filter(Boolean).join(' ').toLowerCase();
          const numero = String(o.id);
          return nomeCliente.includes(alvo) || placa.includes(alvo) || marcaModelo.includes(alvo) || numero.includes(alvo);
        });
      }

      state.orcamentos = enriquecidos;
    } catch (erro) {
      console.error('Erro ao carregar orçamentos:', erro);
      state.orcamentos = [];
      mostrarToast('Erro ao carregar a lista de orçamentos.', 'erro');
    } finally {
      state.carregando = false;
      renderLista();
    }
  }

  /* --------------------------------------------------------------------
     Montagem da tela (uma vez) e eventos
     -------------------------------------------------------------------- */
  function renderShell() {
    const root = document.getElementById('view-orcamentos');
    root.innerHTML = `
      <div class="orcamentos-view">
        <div class="view-toolbar">
          <div class="search-field">
            <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7"/>
              <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
            </svg>
            <input type="search" id="orc-busca" placeholder="Buscar por cliente, placa ou nº do orçamento" autocomplete="off">
          </div>
          <div class="chip-row" id="orc-filtros">
            <button type="button" class="chip is-active" data-status="todos">Todos</button>
            <button type="button" class="chip" data-status="${STATUS.PENDENTE}">Pendente</button>
            <button type="button" class="chip" data-status="${STATUS.APROVADO}">Aprovado</button>
            <button type="button" class="chip" data-status="${STATUS.RECUSADO}">Recusado</button>
            <button type="button" class="chip" data-status="convertidos">Convertidos em OS</button>
          </div>
        </div>
        <div class="orcamentos-lista" id="orc-lista"></div>
      </div>
      <button type="button" class="fab" id="orc-fab" aria-label="Novo orçamento">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    els.lista = document.getElementById('orc-lista');
    els.busca = document.getElementById('orc-busca');
    els.filtros = document.getElementById('orc-filtros');
    els.fab = document.getElementById('orc-fab');
  }

  function bindEventos() {
    let timeoutBusca = null;
    els.busca.addEventListener('input', () => {
      clearTimeout(timeoutBusca);
      timeoutBusca = setTimeout(() => {
        state.termoBusca = els.busca.value;
        carregarOrcamentos();
      }, 200);
    });

    els.filtros.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      els.filtros.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      state.filtroStatus = chip.dataset.status;
      carregarOrcamentos();
    });

    els.fab.addEventListener('click', () => abrirFormulario());

    els.lista.addEventListener('click', (e) => {
      const card = e.target.closest('.orc-card');
      if (card) {
        abrirDetalhe(Number(card.dataset.id));
      }
    });
    Utils.ativarCardComTeclado(els.lista, '.orc-card');
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
      carregarOrcamentos();
    },

    /**
     * Ponto de entrada para outras telas (ex: Histórico do Cliente)
     * abrirem o detalhe completo de um orçamento.
     */
    abrirDetalhePorId(id) {
      return abrirDetalhe(id);
    },
  };
})();

App.modules.register(OrcamentosModule);
