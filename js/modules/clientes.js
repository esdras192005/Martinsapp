/* ======================================================================
   MARTINS — modules/clientes.js
   Tela: Cadastro de Clientes

   Responsabilidades deste módulo:
   - Listar / pesquisar clientes (usa ClientesDB).
   - Criar, editar, excluir e visualizar detalhes de um cliente.
   - Formatar telefone/CPF para exibição e abrir o WhatsApp.

   Este módulo segue o padrão descrito em app.js: um objeto com
   `name`, `init()` e `onNavigate()`, registrado via App.modules.register.
   Toda a interface da tela é montada por aqui (o HTML em index.html só
   tem o contêiner vazio `#view-clientes`).
   ====================================================================== */

const ClientesModule = (() => {

  const NOME_TELA = 'clientes';

  /* --------------------------------------------------------------------
     Estado interno do módulo
     -------------------------------------------------------------------- */
  const state = {
    clientes: [],       // cache local da última listagem/pesquisa carregada
    termoBusca: '',
    carregando: false,
  };

  const els = {};       // referências de elementos, preenchidas em init()

  // Utilitários compartilhados (ver js/core/utils.js) — evita reimplementar
  // formatação e componentes de UI em cada módulo de tela.
  const { apenasDigitos, formatarData, formatarMoeda, escapeHtml, mostrarToast } = Utils;

  /* --------------------------------------------------------------------
     Formatação (telefone, CPF, data) — só para exibição.
     O que fica salvo no banco continua "cru" (ver js/db/clientes.js).
     -------------------------------------------------------------------- */

  function formatarTelefone(valor) {
    const d = apenasDigitos(valor);
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  }

  function formatarCpf(valor) {
    const d = apenasDigitos(valor);
    if (d.length !== 11) return d;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }

  function iniciais(nome) {
    const partes = nome.trim().split(/\s+/).filter(Boolean);
    const primeira = partes[0]?.[0] || '?';
    const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
    return (primeira + ultima).toUpperCase();
  }

  function descreverVeiculo(veiculo) {
    if (!veiculo) return 'Veículo não encontrado';
    const partes = [veiculo.marca, veiculo.modelo].filter(Boolean).join(' ');
    return partes ? `${veiculo.placa} — ${partes}` : veiculo.placa;
  }

  function linkWhatsApp(telefone) {
    let d = apenasDigitos(telefone);
    if (!d) return null;
    if (d.length <= 11) d = `55${d}`; // assume Brasil quando não vier DDI
    return `https://wa.me/${d}`;
  }

  /* --------------------------------------------------------------------
     Máscaras leves nos campos do formulário, enquanto o usuário digita.
     -------------------------------------------------------------------- */
  function aplicarMascaraTelefone(input) {
    input.addEventListener('input', () => {
      let d = apenasDigitos(input.value).slice(0, 11);
      if (d.length > 10) {
        input.value = `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
      } else if (d.length > 5) {
        input.value = `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
      } else if (d.length > 2) {
        input.value = `(${d.slice(0, 2)}) ${d.slice(2)}`;
      } else {
        input.value = d;
      }
    });
  }

  function aplicarMascaraCpf(input) {
    input.addEventListener('input', () => {
      let d = apenasDigitos(input.value).slice(0, 11);
      if (d.length > 9) {
        input.value = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
      } else if (d.length > 6) {
        input.value = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
      } else if (d.length > 3) {
        input.value = `${d.slice(0, 3)}.${d.slice(3)}`;
      } else {
        input.value = d;
      }
    });
  }

  /* --------------------------------------------------------------------
     Modal (bottom sheet), montado a partir de Utils.criarModal. Um único
     modal por vez — a função `abrirModal` troca título/corpo/rodapé
     conforme o que for preciso (formulário, detalhe do cliente ou
     confirmação de exclusão).
     -------------------------------------------------------------------- */
  function montarModal() {
    const modal = Utils.criarModal('clientes-modal-overlay');
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
  }

  /* --------------------------------------------------------------------
     Modal: formulário de criar/editar cliente
     -------------------------------------------------------------------- */
  function abrirFormulario(cliente = null) {
    const editando = Boolean(cliente);

    els.modalCorpo.innerHTML = `
      <form id="cliente-form" novalidate>
        <div class="form-group">
          <label for="campo-nome">Nome completo *</label>
          <input type="text" id="campo-nome" maxlength="80" placeholder="Ex: João da Silva" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="campo-telefone">Telefone *</label>
          <input type="tel" id="campo-telefone" placeholder="(99) 99999-9999" inputmode="numeric" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="campo-cpf">CPF <span class="form-optional">(opcional)</span></label>
          <input type="text" id="campo-cpf" placeholder="000.000.000-00" inputmode="numeric" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="campo-endereco">Endereço <span class="form-optional">(opcional)</span></label>
          <input type="text" id="campo-endereco" maxlength="120" placeholder="Rua, número, bairro, cidade" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="campo-observacoes">Observações</label>
          <textarea id="campo-observacoes" rows="3" maxlength="300" placeholder="Preferências, histórico, alertas..."></textarea>
        </div>
        <p class="form-erro" id="form-erro" hidden></p>
      </form>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-form">Cancelar</button>
      <button type="submit" form="cliente-form" class="btn btn-primary" id="btn-salvar-form">Salvar</button>
    `;

    const campoNome = document.getElementById('campo-nome');
    const campoTelefone = document.getElementById('campo-telefone');
    const campoCpf = document.getElementById('campo-cpf');
    const campoEndereco = document.getElementById('campo-endereco');
    const campoObservacoes = document.getElementById('campo-observacoes');
    const erroEl = document.getElementById('form-erro');

    aplicarMascaraTelefone(campoTelefone);
    aplicarMascaraCpf(campoCpf);

    if (editando) {
      campoNome.value = cliente.nome;
      campoTelefone.value = formatarTelefone(cliente.telefone);
      campoCpf.value = formatarCpf(cliente.cpf);
      campoEndereco.value = cliente.endereco || '';
      campoObservacoes.value = cliente.observacoes || '';
    }

    document.getElementById('btn-cancelar-form').addEventListener('click', fecharModal);

    document.getElementById('cliente-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      erroEl.hidden = true;

      const dados = {
        nome: campoNome.value.trim(),
        telefone: campoTelefone.value,
        cpf: campoCpf.value,
        endereco: campoEndereco.value.trim(),
        observacoes: campoObservacoes.value.trim(),
      };

      const botaoSalvar = document.getElementById('btn-salvar-form');
      botaoSalvar.disabled = true;

      try {
        if (editando) {
          await ClientesDB.atualizar(cliente.id, dados);
          mostrarToast('Cliente atualizado com sucesso.');
        } else {
          await ClientesDB.criar(dados);
          mostrarToast('Cliente cadastrado com sucesso.');
        }
        fecharModal();
        await carregarClientes();
      } catch (erro) {
        erroEl.textContent = erro.message || 'Não foi possível salvar o cliente.';
        erroEl.hidden = false;
        botaoSalvar.disabled = false;
      }
    });

    abrirModal(editando ? 'Editar Cliente' : 'Novo Cliente');
    campoNome.focus();
  }

  /* --------------------------------------------------------------------
     Modal: detalhe do cliente
     -------------------------------------------------------------------- */
  async function abrirDetalhe(id) {
    const cliente = await ClientesDB.buscarPorId(id);
    if (!cliente) {
      mostrarToast('Este cliente não foi encontrado.', 'erro');
      await carregarClientes();
      return;
    }

    const [veiculos, ordensDoCliente] = await Promise.all([
      (typeof VeiculosDB !== 'undefined') ? VeiculosDB.listarPorCliente(cliente.id) : [],
      (typeof OrdensDB !== 'undefined') ? OrdensDB.listarPorCliente(cliente.id) : [],
    ]);

    const veiculosPorId = new Map(veiculos.map((v) => [v.id, v]));

    // Mais recente primeiro, igual à tela de Ordens.
    const ordens = [...ordensDoCliente].sort(
      (a, b) => new Date(b.dataAbertura) - new Date(a.dataAbertura)
    );

    const whats = linkWhatsApp(cliente.telefone);

    const linhaVeiculos = veiculos.length
      ? `<ul class="detalhe-veiculos-lista">
          ${veiculos.map((v) => `
            <li>${escapeHtml(v.placa)}${v.marca || v.modelo ? ` — ${escapeHtml([v.marca, v.modelo].filter(Boolean).join(' '))}` : ''}</li>
          `).join('')}
        </ul>`
      : `<p class="detalhe-vazio">Nenhum veículo vinculado ainda. Em breve será possível cadastrar veículos aqui.</p>`;

    const linhaHistorico = ordens.length
      ? `<div class="hist-os-lista">
          ${ordens.map((ordem) => {
            const veiculo = veiculosPorId.get(ordem.veiculoId) || null;
            const valorPecas = OrdensDB.calcularValorPecas(ordem);
            const valorMaoDeObra = OrdensDB.calcularValorMaoDeObra(ordem);
            const resumoPecas = ordem.pecasUtilizadas.length
              ? ordem.pecasUtilizadas.map((p) => `${p.quantidade}× ${escapeHtml(p.descricao)}`).join(', ')
              : 'Nenhuma peça lançada.';

            return `
              <article class="hist-os-card" data-id="${ordem.id}" role="button" tabindex="0">
                <div class="hist-os-top">
                  <span class="os-numero">OS #${ordem.id}</span>
                  <span class="status-badge status-badge-${ordem.status}">${OrdensDB.STATUS_LABELS[ordem.status]}</span>
                </div>
                <p class="hist-os-data">${formatarData(ordem.dataAbertura)} · ${escapeHtml(descreverVeiculo(veiculo))}</p>
                <p class="hist-os-servicos">${ordem.descricaoServicos ? escapeHtml(ordem.descricaoServicos) : 'Sem descrição registrada.'}</p>
                <p class="hist-os-pecas"><strong>Peças:</strong> ${resumoPecas}</p>
                <div class="hist-os-valores">
                  <span>Peças <strong>${formatarMoeda(valorPecas)}</strong></span>
                  <span>Mão de obra <strong>${formatarMoeda(valorMaoDeObra)}</strong></span>
                  <span class="hist-os-total">Total <strong>${formatarMoeda(ordem.valorTotal)}</strong></span>
                </div>
              </article>
            `;
          }).join('')}
        </div>`
      : `<p class="detalhe-vazio">Nenhuma ordem de serviço registrada para este cliente ainda.</p>`;

    els.modalCorpo.innerHTML = `
      <div class="detalhe-cliente">
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Telefone</span>
          <span class="detalhe-valor">${cliente.telefone ? escapeHtml(formatarTelefone(cliente.telefone)) : '—'}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">CPF</span>
          <span class="detalhe-valor">${cliente.cpf ? escapeHtml(formatarCpf(cliente.cpf)) : '—'}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Endereço</span>
          <span class="detalhe-valor">${cliente.endereco ? escapeHtml(cliente.endereco) : '—'}</span>
        </div>
        <div class="detalhe-linha detalhe-linha-bloco">
          <span class="detalhe-rotulo">Observações</span>
          <span class="detalhe-valor">${cliente.observacoes ? escapeHtml(cliente.observacoes) : '—'}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Data de cadastro</span>
          <span class="detalhe-valor">${formatarData(cliente.createdAt)}</span>
        </div>

        <div class="detalhe-secao">
          <h3 class="detalhe-secao-titulo">Veículos vinculados (${veiculos.length})</h3>
          ${linhaVeiculos}
        </div>

        <div class="detalhe-secao">
          <h3 class="detalhe-secao-titulo">Histórico de Ordens de Serviço (${ordens.length})</h3>
          ${linhaHistorico}
        </div>
      </div>
    `;

    // Delegação de eventos: tocar em qualquer OS do histórico fecha este
    // modal e abre o detalhe completo dela (editar, duplicar, gerar PDF...)
    // na tela de Ordens de Serviço.
    els.modalCorpo.querySelectorAll('.hist-os-card').forEach((card) => {
      const abrir = () => {
        const ordemId = Number(card.dataset.id);
        fecharModal();
        if (typeof OrdensModule !== 'undefined') {
          OrdensModule.abrirDetalhePorId(ordemId);
        }
      };
      card.addEventListener('click', abrir);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          abrir();
        }
      });
    });

    els.modalRodape.innerHTML = `
      ${whats ? `
        <a class="btn btn-whatsapp" href="${whats}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2Zm0 18.2a8.1 8.1 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.6.1-.2.2-.6.8-.8 1-.1.2-.3.2-.5.1-.7-.3-1.4-.7-2-1.3-.5-.5-1-1.1-1.4-1.8-.1-.2 0-.4.1-.5l.4-.5c.1-.1.2-.3.2-.4.1-.2 0-.3 0-.4-.1-.1-.6-1.4-.8-1.9-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.7.7-1 1.4-1 2.3.1 1 .8 2.1 1 2.3 0 0 1.7 2.7 4.2 3.7.6.2 1 .4 1.4.5.6.2 1.1.2 1.5.1.5-.1 1.4-.6 1.6-1.1.2-.5.2-1 .1-1.1-.1-.1-.2-.2-.4-.3Z"/></svg>
          WhatsApp
        </a>
      ` : ''}
      <button type="button" class="btn btn-secondary" id="btn-editar-cliente">Editar</button>
      <button type="button" class="btn btn-danger" id="btn-excluir-cliente">Excluir</button>
    `;

    document.getElementById('btn-editar-cliente').addEventListener('click', () => {
      fecharModal();
      abrirFormulario(cliente);
    });

    document.getElementById('btn-excluir-cliente').addEventListener('click', () => {
      abrirConfirmacaoExclusao(cliente);
    });

    abrirModal(cliente.nome);
  }

  /* --------------------------------------------------------------------
     Modal: confirmação de exclusão
     -------------------------------------------------------------------- */
  function abrirConfirmacaoExclusao(cliente) {
    els.modalCorpo.innerHTML = `
      <p class="confirmacao-texto">
        Tem certeza que deseja excluir <strong>${escapeHtml(cliente.nome)}</strong>?
        Esta ação não pode ser desfeita.
      </p>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-exclusao">Cancelar</button>
      <button type="button" class="btn btn-danger" id="btn-confirmar-exclusao">Excluir</button>
    `;

    document.getElementById('btn-cancelar-exclusao').addEventListener('click', () => {
      fecharModal();
      abrirDetalhe(cliente.id);
    });

    document.getElementById('btn-confirmar-exclusao').addEventListener('click', async () => {
      const botao = document.getElementById('btn-confirmar-exclusao');
      botao.disabled = true;
      try {
        await ClientesDB.excluir(cliente.id);
        fecharModal();
        mostrarToast('Cliente excluído.');
        await carregarClientes();
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível excluir o cliente.', 'erro');
        botao.disabled = false;
      }
    });

    abrirModal('Excluir cliente');
  }

  /* --------------------------------------------------------------------
     Lista principal
     -------------------------------------------------------------------- */
  function renderLista() {
    if (!els.lista) return;

    if (state.carregando) {
      els.lista.innerHTML = `<p class="clientes-status">Carregando clientes...</p>`;
      return;
    }

    if (!state.clientes.length) {
      const mensagem = state.termoBusca
        ? 'Nenhum cliente encontrado para essa busca.'
        : 'Nenhum cliente cadastrado ainda. Toque em “Novo Cliente” para começar.';

      els.lista.innerHTML = `
        <div class="empty-state">
          <h2>Nada por aqui</h2>
          <p>${mensagem}</p>
        </div>
      `;
      return;
    }

    els.lista.innerHTML = state.clientes.map((cliente) => `
      <article class="cliente-card" data-id="${cliente.id}" role="button" tabindex="0">
        <div class="cliente-avatar" aria-hidden="true">${iniciais(cliente.nome)}</div>
        <div class="cliente-info">
          <h3 class="cliente-nome">${escapeHtml(cliente.nome)}</h3>
          <p class="cliente-sub">${cliente.telefone ? escapeHtml(formatarTelefone(cliente.telefone)) : 'Sem telefone'}</p>
        </div>
        <button
          type="button"
          class="cliente-whats-btn"
          data-action="whatsapp"
          data-id="${cliente.id}"
          aria-label="Abrir conversa no WhatsApp"
          ${cliente.telefone ? '' : 'disabled'}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2Zm0 18.2a8.1 8.1 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.6.1-.2.2-.6.8-.8 1-.1.2-.3.2-.5.1-.7-.3-1.4-.7-2-1.3-.5-.5-1-1.1-1.4-1.8-.1-.2 0-.4.1-.5l.4-.5c.1-.1.2-.3.2-.4.1-.2 0-.3 0-.4-.1-.1-.6-1.4-.8-1.9-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.7.7-1 1.4-1 2.3.1 1 .8 2.1 1 2.3 0 0 1.7 2.7 4.2 3.7.6.2 1 .4 1.4.5.6.2 1.1.2 1.5.1.5-.1 1.4-.6 1.6-1.1.2-.5.2-1 .1-1.1-.1-.1-.2-.2-.4-.3Z"/></svg>
        </button>
      </article>
    `).join('');
  }

  async function carregarClientes() {
    state.carregando = true;
    renderLista();

    try {
      state.clientes = state.termoBusca
        ? await ClientesDB.pesquisar(state.termoBusca)
        : await ClientesDB.listarTodos();
    } catch (erro) {
      console.error('Erro ao carregar clientes:', erro);
      state.clientes = [];
      mostrarToast('Erro ao carregar a lista de clientes.', 'erro');
    } finally {
      state.carregando = false;
      renderLista();
    }
  }

  /* --------------------------------------------------------------------
     Montagem da tela (uma vez) e eventos
     -------------------------------------------------------------------- */
  function renderShell() {
    const root = document.getElementById('view-clientes');
    root.innerHTML = `
      <div class="clientes-view">
        <div class="view-toolbar">
          <div class="search-field">
            <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7"/>
              <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
            </svg>
            <input type="search" id="clientes-busca" placeholder="Buscar por nome, telefone ou CPF" autocomplete="off">
          </div>
        </div>
        <div class="clientes-lista" id="clientes-lista"></div>
      </div>
      <button type="button" class="fab" id="clientes-fab" aria-label="Novo cliente">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    els.lista = document.getElementById('clientes-lista');
    els.busca = document.getElementById('clientes-busca');
    els.fab = document.getElementById('clientes-fab');
  }

  function bindEventos() {
    let timeoutBusca = null;
    els.busca.addEventListener('input', () => {
      clearTimeout(timeoutBusca);
      timeoutBusca = setTimeout(() => {
        state.termoBusca = els.busca.value;
        carregarClientes();
      }, 200);
    });

    els.fab.addEventListener('click', () => abrirFormulario());

    // Delegação de eventos: um único listener cuida de todos os cards,
    // mesmo quando a lista é recriada a cada carregamento.
    els.lista.addEventListener('click', (e) => {
      const botaoWhats = e.target.closest('[data-action="whatsapp"]');
      if (botaoWhats) {
        e.stopPropagation();
        const cliente = state.clientes.find((c) => c.id === Number(botaoWhats.dataset.id));
        const link = cliente && linkWhatsApp(cliente.telefone);
        if (link) window.open(link, '_blank', 'noopener');
        return;
      }

      const card = e.target.closest('.cliente-card');
      if (card) {
        abrirDetalhe(Number(card.dataset.id));
      }
    });
    Utils.ativarCardComTeclado(els.lista, '.cliente-card');
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
      carregarClientes();
    },

    /**
     * Ponto de entrada para outras telas (ex: Pesquisa Global) abrirem
     * o detalhe completo de um cliente.
     */
    abrirDetalhePorId(id) {
      return abrirDetalhe(id);
    },
  };
})();

App.modules.register(ClientesModule);
