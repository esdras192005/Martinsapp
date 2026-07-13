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
          <div id="orc-form-lista-ma
