/* ======================================================================
   MARTINS — modules/estoque.js
   Tela: Estoque de Peças

   Responsabilidades deste módulo:
   - Listar / pesquisar / filtrar peças do catálogo (PecasDB).
   - Criar, editar, ajustar quantidade e excluir peças.
   - Alertar quando uma peça atinge o estoque mínimo (banner + filtro).
   - Lançar uma NOTA FISCAL DE COMPRA (reaproveitando o LeitorNotaFiscal
     já usado nas Ordens de Serviço) para dar entrada automática no
     estoque, casando itens por código/nome ou cadastrando peça nova.

   A baixa automática de estoque ao USAR uma peça em uma Ordem de
   Serviço não mora aqui: é feita em js/db/ordens.js (sincronizarEstoque),
   para que aconteça de forma consistente não importa por onde a OS
   seja criada/editada/excluída. Este módulo só CONSOME o resultado
   (a lista de peças sempre já vem com a quantidade correta).

   Segue o mesmo padrão de módulo dos demais arquivos em js/modules/.
   ====================================================================== */

const EstoqueModule = (() => {

  const NOME_TELA = 'estoque';

  /* --------------------------------------------------------------------
     Estado interno do módulo
     -------------------------------------------------------------------- */
  const state = {
    pecas: [],             // cache da última listagem/pesquisa carregada
    termoBusca: '',
    filtro: 'todas',        // 'todas' | 'baixo'
    carregando: false,
  };

  const els = {};

  // Utilitários compartilhados (ver js/core/utils.js).
  const { formatarMoeda, escapeHtml, mostrarToast } = Utils;

  /* --------------------------------------------------------------------
     Regras de estoque baixo
     -------------------------------------------------------------------- */

  function estaBaixo(peca) {
    return peca.estoqueMinimo > 0 && peca.quantidadeEstoque <= peca.estoqueMinimo;
  }

  /* --------------------------------------------------------------------
     Modal (bottom sheet), montado a partir de Utils.criarModal, com id
     próprio deste módulo.
     -------------------------------------------------------------------- */
  function montarModal() {
    const modal = Utils.criarModal('estoque-modal-overlay');
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
     Formulário: criar/editar peça
     -------------------------------------------------------------------- */
  function abrirFormulario(peca = null) {
    const editando = Boolean(peca);

    els.modalCorpo.innerHTML = `
      <form id="peca-form" novalidate>
        <div class="form-group">
          <label for="campo-peca-nome">Descrição *</label>
          <input type="text" id="campo-peca-nome" maxlength="120" placeholder="Ex: Pastilha de freio dianteira" value="${escapeHtml(peca?.nome || '')}" autocomplete="off">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="campo-peca-marca">Marca <span class="form-optional">(opcional)</span></label>
            <input type="text" id="campo-peca-marca" maxlength="60" placeholder="Ex: Bosch" value="${escapeHtml(peca?.marca || '')}" autocomplete="off">
          </div>
          <div class="form-group">
            <label for="campo-peca-codigo">Código <span class="form-optional">(opcional)</span></label>
            <input type="text" id="campo-peca-codigo" maxlength="60" placeholder="Ex: BR-1234" value="${escapeHtml(peca?.codigo || '')}" autocomplete="off">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="campo-peca-qtd">Quantidade em estoque *</label>
            <input type="number" id="campo-peca-qtd" min="0" step="1" value="${peca?.quantidadeEstoque ?? 0}" inputmode="numeric">
          </div>
          <div class="form-group">
            <label for="campo-peca-minimo">Estoque mínimo *</label>
            <input type="number" id="campo-peca-minimo" min="0" step="1" value="${peca?.estoqueMinimo ?? 0}" inputmode="numeric">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="campo-peca-custo">Preço de custo *</label>
            <input type="number" id="campo-peca-custo" min="0" step="0.01" value="${peca?.precoCusto ?? ''}" inputmode="decimal">
          </div>
          <div class="form-group">
            <label for="campo-peca-venda">Preço de venda <span class="form-optional">(opcional)</span></label>
            <input type="number" id="campo-peca-venda" min="0" step="0.01" value="${peca?.precoVenda || ''}" inputmode="decimal">
          </div>
        </div>
        <div class="form-group">
          <label for="campo-peca-fornecedor">Fornecedor <span class="form-optional">(opcional)</span></label>
          <input type="text" id="campo-peca-fornecedor" maxlength="80" placeholder="Ex: Distribuidora Central" value="${escapeHtml(peca?.fornecedor || '')}" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="campo-peca-observacoes">Observações <span class="form-optional">(opcional)</span></label>
          <textarea id="campo-peca-observacoes" rows="3" maxlength="500" placeholder="Detalhes adicionais...">${escapeHtml(peca?.observacoes || '')}</textarea>
        </div>
        <p class="form-erro" id="peca-form-erro" hidden></p>
      </form>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-form-peca">Cancelar</button>
      <button type="submit" form="peca-form" class="btn btn-primary" id="btn-salvar-form-peca">Salvar</button>
    `;

    document.getElementById('btn-cancelar-form-peca').addEventListener('click', fecharModal);

    const erroEl = document.getElementById('peca-form-erro');

    document.getElementById('peca-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      erroEl.hidden = true;

      const dados = {
        nome: document.getElementById('campo-peca-nome').value.trim(),
        marca: document.getElementById('campo-peca-marca').value.trim(),
        codigo: document.getElementById('campo-peca-codigo').value.trim(),
        quantidadeEstoque: Number(document.getElementById('campo-peca-qtd').value) || 0,
        estoqueMinimo: Number(document.getElementById('campo-peca-minimo').value) || 0,
        precoCusto: Number(document.getElementById('campo-peca-custo').value) || 0,
        precoVenda: Number(document.getElementById('campo-peca-venda').value) || 0,
        fornecedor: document.getElementById('campo-peca-fornecedor').value.trim(),
        observacoes: document.getElementById('campo-peca-observacoes').value.trim(),
      };

      const botaoSalvar = document.getElementById('btn-salvar-form-peca');
      botaoSalvar.disabled = true;

      try {
        if (editando) {
          await PecasDB.atualizar(peca.id, dados);
          mostrarToast('Peça atualizada com sucesso.');
        } else {
          await PecasDB.criar(dados);
          mostrarToast('Peça cadastrada com sucesso.');
        }
        fecharModal();
        await carregarPecas();
      } catch (erro) {
        erroEl.textContent = erro.message || 'Não foi possível salvar a peça.';
        erroEl.hidden = false;
        botaoSalvar.disabled = false;
      }
    });

    abrirModal(editando ? 'Editar peça' : 'Nova peça');
  }

  /* --------------------------------------------------------------------
     Detalhe da peça (com ajuste rápido de estoque)
     -------------------------------------------------------------------- */
  async function abrirDetalhe(id) {
    const peca = await PecasDB.buscarPorId(id);
    if (!peca) {
      mostrarToast('Esta peça não foi encontrada.', 'erro');
      await carregarPecas();
      return;
    }

    const baixo = estaBaixo(peca);

    els.modalCorpo.innerHTML = `
      <div class="detalhe-os">
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Estoque</span>
          <span class="status-badge ${baixo ? 'status-badge-baixo' : 'status-badge-normal'}">
            ${peca.quantidadeEstoque} ${peca.unidade || 'un'}${baixo ? ' · baixo' : ''}
          </span>
        </div>
        ${peca.marca ? `
          <div class="detalhe-linha">
            <span class="detalhe-rotulo">Marca</span>
            <span class="detalhe-valor">${escapeHtml(peca.marca)}</span>
          </div>` : ''}
        ${peca.codigo ? `
          <div class="detalhe-linha">
            <span class="detalhe-rotulo">Código</span>
            <span class="detalhe-valor">${escapeHtml(peca.codigo)}</span>
          </div>` : ''}
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Estoque mínimo</span>
          <span class="detalhe-valor">${peca.estoqueMinimo}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Preço de custo</span>
          <span class="detalhe-valor">${formatarMoeda(peca.precoCusto)}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Preço de venda</span>
          <span class="detalhe-valor">${peca.precoVenda ? formatarMoeda(peca.precoVenda) : '—'}</span>
        </div>
        ${peca.fornecedor ? `
          <div class="detalhe-linha">
            <span class="detalhe-rotulo">Fornecedor</span>
            <span class="detalhe-valor">${escapeHtml(peca.fornecedor)}</span>
          </div>` : ''}
        <div class="detalhe-linha detalhe-linha-bloco">
          <span class="detalhe-rotulo">Observações</span>
          <span class="detalhe-valor">${peca.observacoes ? escapeHtml(peca.observacoes) : '—'}</span>
        </div>

        <div class="estoque-ajuste">
          <span class="detalhe-rotulo">Ajustar estoque</span>
          <div class="estoque-ajuste-stepper">
            <button type="button" class="estoque-stepper-btn" id="btn-estoque-menos" aria-label="Diminuir">−</button>
            <input type="number" id="campo-estoque-delta" value="1" min="1" step="1" inputmode="numeric">
            <button type="button" class="estoque-stepper-btn" id="btn-estoque-mais" aria-label="Aumentar">+</button>
          </div>
        </div>
      </div>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-editar-peca">Editar</button>
      <button type="button" class="btn btn-danger" id="btn-excluir-peca">Excluir</button>
    `;

    const aplicarAjuste = async (sinal) => {
      const delta = Number(document.getElementById('campo-estoque-delta').value) || 0;
      if (delta <= 0) return;
      try {
        await PecasDB.ajustarEstoque(peca.id, sinal * delta);
        mostrarToast(sinal > 0 ? 'Entrada registrada no estoque.' : 'Saída registrada no estoque.');
        await carregarPecas();
        await abrirDetalhe(peca.id);
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível ajustar o estoque.', 'erro');
      }
    };

    document.getElementById('btn-estoque-mais').addEventListener('click', () => aplicarAjuste(1));
    document.getElementById('btn-estoque-menos').addEventListener('click', () => aplicarAjuste(-1));

    document.getElementById('btn-editar-peca').addEventListener('click', () => {
      fecharModal();
      abrirFormulario(peca);
    });

    document.getElementById('btn-excluir-peca').addEventListener('click', () => {
      abrirConfirmacaoExclusao(peca);
    });

    abrirModal(peca.nome);
  }

  function abrirConfirmacaoExclusao(peca) {
    els.modalCorpo.innerHTML = `
      <p class="confirmacao-texto">
        Tem certeza que deseja excluir <strong>${escapeHtml(peca.nome)}</strong> do estoque?
        Esta ação não pode ser desfeita.
      </p>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-exclusao-peca">Cancelar</button>
      <button type="button" class="btn btn-danger" id="btn-confirmar-exclusao-peca">Excluir</button>
    `;

    document.getElementById('btn-cancelar-exclusao-peca').addEventListener('click', () => {
      fecharModal();
      abrirDetalhe(peca.id);
    });

    document.getElementById('btn-confirmar-exclusao-peca').addEventListener('click', async () => {
      const botao = document.getElementById('btn-confirmar-exclusao-peca');
      botao.disabled = true;
      try {
        await PecasDB.excluir(peca.id);
        fecharModal();
        mostrarToast('Peça excluída.');
        await carregarPecas();
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível excluir a peça.', 'erro');
        botao.disabled = false;
      }
    });

    abrirModal('Excluir peça');
  }

  /* --------------------------------------------------------------------
     Leitor de nota fiscal de COMPRA — dá entrada automática no estoque
     -------------------------------------------------------------------- */
  function abrirLeitorNotaDeCompra() {
    LeitorNotaFiscal.abrir({
      async onConfirmar(itensLidos) {
        try {
          const resultado = await PecasDB.receberNotaDeCompra(itensLidos);
          const partes = [];
          if (resultado.atualizadas) partes.push(`${resultado.atualizadas} peça(s) com entrada de estoque`);
          if (resultado.criadas) partes.push(`${resultado.criadas} peça(s) nova(s) cadastrada(s)`);
          mostrarToast(partes.length ? `Nota processada: ${partes.join(' e ')}.` : 'Nenhum item válido encontrado na nota.', partes.length ? 'sucesso' : 'erro');
          await carregarPecas();
        } catch (erro) {
          console.error('Erro ao processar nota fiscal de compra:', erro);
          mostrarToast('Erro ao atualizar o estoque a partir da nota fiscal.', 'erro');
        }
      },
    });
  }

  /* --------------------------------------------------------------------
     Banner de alerta de estoque baixo
     -------------------------------------------------------------------- */
  function renderBannerEstoqueBaixo(qtdBaixo) {
    if (!els.banner) return;
    if (!qtdBaixo) {
      els.banner.hidden = true;
      return;
    }
    els.banner.hidden = false;
    els.banner.innerHTML = `
      ⚠ ${qtdBaixo} peça${qtdBaixo > 1 ? 's' : ''} no estoque mínimo ou abaixo dele.
      <button type="button" id="btn-ver-estoque-baixo">Ver</button>
    `;
    document.getElementById('btn-ver-estoque-baixo').addEventListener('click', () => {
      state.filtro = 'baixo';
      els.filtros.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filtro === 'baixo'));
      carregarPecas();
    });
  }

  /* --------------------------------------------------------------------
     Lista de peças (com busca e filtros)
     -------------------------------------------------------------------- */
  function renderLista() {
    if (!els.lista) return;

    if (state.carregando) {
      els.lista.innerHTML = `<p class="clientes-status">Carregando estoque...</p>`;
      return;
    }

    if (!state.pecas.length) {
      const mensagem = (state.termoBusca || state.filtro !== 'todas')
        ? 'Nenhuma peça encontrada para esse filtro.'
        : 'Nenhuma peça cadastrada ainda. Toque em “+” para começar.';

      els.lista.innerHTML = `
        <div class="empty-state">
          <h2>Nada por aqui</h2>
          <p>${mensagem}</p>
        </div>
      `;
      return;
    }

    els.lista.innerHTML = state.pecas.map((peca) => {
      const baixo = estaBaixo(peca);
      const sub = [peca.marca, peca.codigo ? `#${peca.codigo}` : null].filter(Boolean).join(' · ');
      return `
        <article class="peca-card" data-id="${peca.id}" role="button" tabindex="0">
          <div class="peca-card-top">
            <h3 class="peca-descricao">${escapeHtml(peca.nome)}</h3>
            <span class="status-badge ${baixo ? 'status-badge-baixo' : 'status-badge-normal'}">${peca.quantidadeEstoque} ${peca.unidade || 'un'}</span>
          </div>
          ${sub ? `<p class="peca-sub">${escapeHtml(sub)}</p>` : ''}
          <div class="peca-card-bottom">
            <span class="peca-fornecedor">${peca.fornecedor ? escapeHtml(peca.fornecedor) : '—'}</span>
            <span class="peca-valor">${formatarMoeda(peca.precoVenda || peca.precoCusto)}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  async function carregarPecas() {
    state.carregando = true;
    renderLista();

    try {
      let lista = state.termoBusca ? await PecasDB.buscar(state.termoBusca) : await PecasDB.listarTodas();

      const qtdBaixo = (await PecasDB.listarEstoqueBaixo()).length;
      renderBannerEstoqueBaixo(qtdBaixo);

      if (state.filtro === 'baixo') {
        lista = lista.filter(estaBaixo);
      }

      state.pecas = lista;
    } catch (erro) {
      console.error('Erro ao carregar o estoque:', erro);
      state.pecas = [];
      mostrarToast('Erro ao carregar a lista de peças.', 'erro');
    } finally {
      state.carregando = false;
      renderLista();
    }
  }

  /* --------------------------------------------------------------------
     Montagem da tela (uma vez) e eventos
     -------------------------------------------------------------------- */
  function renderShell() {
    const root = document.getElementById('view-estoque');
    root.innerHTML = `
      <div class="estoque-view">
        <div class="estoque-banner-baixo" id="estoque-banner-baixo" hidden></div>

        <div class="view-toolbar">
          <div class="search-field">
            <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7"/>
              <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
            </svg>
            <input type="search" id="estoque-busca" placeholder="Buscar por descrição, marca, código ou fornecedor" autocomplete="off">
          </div>
          <div class="chip-row" id="estoque-filtros">
            <button type="button" class="chip is-active" data-filtro="todas">Todas</button>
            <button type="button" class="chip" data-filtro="baixo">Estoque baixo</button>
          </div>
          <button type="button" class="btn btn-secondary estoque-btn-nota" id="estoque-btn-nota">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5Z" stroke-linejoin="round"/>
              <path d="M14 3.5V7a1 1 0 0 0 1 1h3.5" stroke-linejoin="round"/>
              <path d="M9 12.5h6M9 15.5h6M9 9.5h2.5" stroke-linecap="round"/>
            </svg>
            Lançar nota de compra
          </button>
        </div>

        <div class="peca-lista" id="estoque-lista"></div>
      </div>
      <button type="button" class="fab" id="estoque-fab" aria-label="Nova peça">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    els.banner = document.getElementById('estoque-banner-baixo');
    els.lista = document.getElementById('estoque-lista');
    els.busca = document.getElementById('estoque-busca');
    els.filtros = document.getElementById('estoque-filtros');
    els.botaoNota = document.getElementById('estoque-btn-nota');
    els.fab = document.getElementById('estoque-fab');
  }

  function bindEventos() {
    let timeoutBusca = null;
    els.busca.addEventListener('input', () => {
      clearTimeout(timeoutBusca);
      timeoutBusca = setTimeout(() => {
        state.termoBusca = els.busca.value;
        carregarPecas();
      }, 200);
    });

    els.filtros.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      els.filtros.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      state.filtro = chip.dataset.filtro;
      carregarPecas();
    });

    els.botaoNota.addEventListener('click', abrirLeitorNotaDeCompra);

    els.fab.addEventListener('click', () => abrirFormulario());

    els.lista.addEventListener('click', (e) => {
      const card = e.target.closest('.peca-card');
      if (card) {
        abrirDetalhe(Number(card.dataset.id));
      }
    });
    Utils.ativarCardComTeclado(els.lista, '.peca-card');
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
      carregarPecas();
    },

    /**
     * Ponto de entrada para outras telas (ex: Pesquisa Global) abrirem
     * o detalhe completo de uma peça do estoque.
     */
    abrirDetalhePorId(id) {
      return abrirDetalhe(id);
    },
  };
})();

App.modules.register(EstoqueModule);
