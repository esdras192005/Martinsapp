/* ======================================================================
   MARTINS — modules/ordens.js
   Tela: Ordens de Serviço

   Responsabilidades deste módulo:
   - Listar / pesquisar / filtrar ordens de serviço por status (usa OrdensDB).
   - Criar, editar, finalizar, marcar como entregue e excluir uma OS.
   - Montar o formulário com seleção de cliente/veículo já cadastrados,
     peças, mão de obra, descrição do serviço e cálculo automático do total.
   - Servir de ponto de entrada para o futuro leitor de nota fiscal
     (notinhas): ver `receberPecasDoScanner` no fim deste arquivo.

   Segue o mesmo padrão de js/modules/clientes.js: um objeto com `name`,
   `init()` e `onNavigate()`, registrado via App.modules.register. Toda a
   interface é montada por aqui (o HTML em index.html só tem o contêiner
   vazio `#view-ordens`).
   ====================================================================== */

const OrdensModule = (() => {

  const NOME_TELA = 'ordens';
  const { STATUS, STATUS_LABELS, MOMENTOS_FOTO, MOMENTO_FOTO_LABELS } = OrdensDB;

  // Fotos da OS: redimensiona antes de gravar, para não inflar o
  // IndexedDB com fotos de câmera em resolução total (o app é local,
  // sem servidor, então tudo que entra aqui fica salvo no dispositivo).
  const FOTO_LIMITE_LADO_MAIOR_PX = 1600;
  const FOTO_QUALIDADE_JPEG = 0.82;

  // Sugestões rápidas de checklist: apenas atalhos para digitar mais
  // rápido (viram um chip clicável). O checklist em si é 100% livre —
  // o usuário pode digitar qualquer tarefa, é isso que o torna
  // "personalizado" para cada veículo/serviço, sem precisar de uma
  // tela separada de templates.
  const SUGESTOES_CHECKLIST = [
    'Trocar óleo do motor',
    'Trocar filtro de óleo',
    'Trocar filtro de ar',
    'Apertar rodas (torque)',
    'Testar freios',
    'Conferir vazamentos',
    'Verificar nível de fluidos',
    'Calibrar pneus',
    'Testar luzes e setas',
    'Verificar bateria',
  ];

  /* --------------------------------------------------------------------
     Estado interno do módulo
     -------------------------------------------------------------------- */
  const state = {
    ordens: [],            // cache enriquecido (com cliente/veículo) da última listagem
    termoBusca: '',
    filtroStatus: 'todas',
    carregando: false,

    clientes: [],          // cache para popular os selects do formulário
    veiculos: [],
    pecasCatalogo: [],
    maoDeObraCatalogo: [],

    formPecas: [],         // itens temporários enquanto o formulário está aberto
    formMaoDeObra: [],
    formNotas: [],          // notas fiscais (fotos) fixadas temporariamente no formulário

    modalModo: null,       // 'detalhe' | 'formulario' | 'exclusao' | null
    modalOrdemId: null,    // id da OS atualmente aberta no modal (usado pelo hook do scanner)
  };

  const els = {};

  // Utilitários compartilhados (ver js/core/utils.js).
  const { formatarMoeda, formatarData, escapeHtml, mostrarToast } = Utils;

  /* --------------------------------------------------------------------
     Formatação
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
     Fotos da OS: captura (câmera ou galeria), redimensionamento local
     via Canvas e geração de um data URL pronto para <img src> — tanto na
     galeria da tela quanto no PDF. Sem envio a nenhum servidor.
     -------------------------------------------------------------------- */
  async function carregarArquivoComoImagem(arquivo) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(arquivo);
      } catch (e) {
        // cai para o fallback abaixo
      }
    }
    const url = URL.createObjectURL(arquivo);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Redimensiona (mantendo proporção) e comprime uma foto escolhida/tirada pelo usuário, devolvendo um data URL JPEG pronto para gravar. */
  async function prepararFotoOS(arquivo) {
    const imagem = await carregarArquivoComoImagem(arquivo);
    const largura = imagem.width || imagem.naturalWidth;
    const altura = imagem.height || imagem.naturalHeight;
    const escala = Math.min(1, FOTO_LIMITE_LADO_MAIOR_PX / Math.max(largura, altura));
    const larguraFinal = Math.max(1, Math.round(largura * escala));
    const alturaFinal = Math.max(1, Math.round(altura * escala));

    const canvas = document.createElement('canvas');
    canvas.width = larguraFinal;
    canvas.height = alturaFinal;
    canvas.getContext('2d').drawImage(imagem, 0, 0, larguraFinal, alturaFinal);

    return { dataUrl: canvas.toDataURL('image/jpeg', FOTO_QUALIDADE_JPEG) };
  }

  /** Agrupa as fotos da OS por momento (antes/durante/depois) na ordem certa para exibição, descartando grupos vazios. Devolve também a lista já "achatada" na mesma ordem, usada para navegar no visualizador de zoom. */
  function agruparFotosPorMomento(fotos) {
    const ordemGrupos = [MOMENTOS_FOTO.ANTES, MOMENTOS_FOTO.DURANTE, MOMENTOS_FOTO.DEPOIS];
    const grupos = ordemGrupos
      .map((chave) => ({ chave, titulo: MOMENTO_FOTO_LABELS[chave], itens: fotos.filter((f) => f.momento === chave) }))
      .filter((g) => g.itens.length);
    const achatada = grupos.flatMap((g) => g.itens);
    return { grupos, achatada };
  }

  /** Monta o HTML da galeria de fotos do detalhe da OS, agrupada por momento. */
  function montarGaleriaFotosHtml(fotos) {
    const { grupos } = agruparFotosPorMomento(fotos);
    if (!grupos.length) {
      return '<p class="os-itens-vazio">Nenhuma foto adicionada ainda.</p>';
    }
    return grupos.map((g) => `
      <div class="os-fotos-grupo">
        <span class="os-fotos-grupo-titulo">${g.titulo}</span>
        <div class="os-fotos-linha">
          ${g.itens.map((f) => `
            <div class="os-foto-thumb" data-foto-id="${f.id}" role="button" tabindex="0" aria-label="Ampliar foto${f.legenda ? `: ${escapeHtml(f.legenda)}` : ''}">
              <img src="${f.dataUrl}" alt="${escapeHtml(f.legenda || 'Foto da OS')}">
              <button type="button" class="os-foto-remover" data-remover-foto="${f.id}" aria-label="Remover foto">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  /* --------------------------------------------------------------------
     Visualizador de foto em tela cheia (zoom). É um overlay próprio,
     fora do bottom-sheet padrão (Utils.criarModal), pois precisa ocupar
     a tela toda para mostrar a imagem em alta resolução.
     -------------------------------------------------------------------- */
  function abrirVisualizadorFoto(fotos, indiceInicial, ordemId) {
    let indice = indiceInicial;

    const overlay = document.createElement('div');
    overlay.className = 'foto-zoom-overlay';
    overlay.innerHTML = `
      <button type="button" class="foto-zoom-fechar" aria-label="Fechar">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
      </button>
      ${fotos.length > 1 ? `
        <button type="button" class="foto-zoom-nav foto-zoom-anterior" aria-label="Foto anterior">‹</button>
        <button type="button" class="foto-zoom-nav foto-zoom-proxima" aria-label="Próxima foto">›</button>
      ` : ''}
      <div class="foto-zoom-viewport">
        <img class="foto-zoom-img" alt="Foto da ordem de serviço">
      </div>
      <p class="foto-zoom-legenda" id="foto-zoom-legenda" title="Toque para editar a legenda"></p>
    `;
    document.body.appendChild(overlay);
    document.body.classList.add('modal-aberto');

    const imgEl = overlay.querySelector('.foto-zoom-img');
    const legendaEl = overlay.querySelector('#foto-zoom-legenda');

    function render() {
      const foto = fotos[indice];
      imgEl.src = foto.dataUrl;
      imgEl.classList.remove('is-zoomed');
      legendaEl.textContent = foto.legenda || 'Toque para adicionar uma legenda';
      legendaEl.classList.toggle('foto-zoom-legenda-vazia', !foto.legenda);
    }

    function fechar() {
      overlay.remove();
      if (!document.querySelector('.modal-overlay.is-open')) document.body.classList.remove('modal-aberto');
      document.removeEventListener('keydown', aoTeclar);
    }

    function aoTeclar(e) {
      if (e.key === 'Escape') fechar();
      if (e.key === 'ArrowLeft' && fotos.length > 1) { indice = (indice - 1 + fotos.length) % fotos.length; render(); }
      if (e.key === 'ArrowRight' && fotos.length > 1) { indice = (indice + 1) % fotos.length; render(); }
    }

    overlay.querySelector('.foto-zoom-fechar').addEventListener('click', fechar);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });
    document.addEventListener('keydown', aoTeclar);

    // Toque na imagem alterna entre tamanho normal e ampliado (o
    // navegador ainda permite pinça para dar zoom nativo por cima disso).
    imgEl.addEventListener('click', (e) => {
      e.stopPropagation();
      imgEl.classList.toggle('is-zoomed');
    });

    if (fotos.length > 1) {
      overlay.querySelector('.foto-zoom-anterior').addEventListener('click', (e) => {
        e.stopPropagation();
        indice = (indice - 1 + fotos.length) % fotos.length;
        render();
      });
      overlay.querySelector('.foto-zoom-proxima').addEventListener('click', (e) => {
        e.stopPropagation();
        indice = (indice + 1) % fotos.length;
        render();
      });
    }

    legendaEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const foto = fotos[indice];
      const novaLegenda = prompt('Legenda da foto (opcional):', foto.legenda || '');
      if (novaLegenda === null) return; // cancelado
      const legendaLimpa = novaLegenda.trim() || null;
      try {
        await OrdensDB.atualizarFoto(ordemId, foto.id, { legenda: legendaLimpa });
        foto.legenda = legendaLimpa;
        render();
        mostrarToast('Legenda atualizada.');
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível atualizar a legenda.', 'erro');
      }
    });

    render();
  }

  /* --------------------------------------------------------------------
     Modal (bottom sheet), montado a partir de Utils.criarModal, com ids
     isolados deste módulo para não colidir com outros modais.
     -------------------------------------------------------------------- */
  function montarModal() {
    const modal = Utils.criarModal('ordens-modal-overlay');
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
    state.modalOrdemId = null;
  }

  /* --------------------------------------------------------------------
     Formulário: itens de peças e mão de obra (subformulários inline)
     -------------------------------------------------------------------- */
  function montarFormAddPeca() {
    const opcoesCatalogo = state.pecasCatalogo
      .map((p) => `<option value="${p.id}">${escapeHtml(p.nome)} (${formatarMoeda(p.precoVenda)})</option>`)
      .join('');

    return `
      <div class="form-group">
        <label for="add-peca-catalogo">Peça do estoque <span class="form-optional">(opcional)</span></label>
        <select id="add-peca-catalogo">
          <option value="">Digitar manualmente</option>
          ${opcoesCatalogo}
        </select>
      </div>
      <div class="form-group">
        <label for="add-peca-descricao">Descrição</label>
        <input type="text" id="add-peca-descricao" maxlength="120" placeholder="Ex: Pastilha de freio dianteira" autocomplete="off">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="add-peca-marca">Marca <span class="form-optional">(opcional)</span></label>
          <input type="text" id="add-peca-marca" maxlength="60" placeholder="Ex: Bosch" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="add-peca-codigo">Código <span class="form-optional">(opcional)</span></label>
          <input type="text" id="add-peca-codigo" maxlength="60" placeholder="Ex: BR-1234" autocomplete="off">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="add-peca-qtd">Quantidade</label>
          <input type="number" id="add-peca-qtd" min="1" step="1" value="1" inputmode="numeric">
        </div>
        <div class="form-group">
          <label for="add-peca-valor">Valor unitário</label>
          <input type="number" id="add-peca-valor" min="0" step="0.01" value="0" inputmode="decimal">
        </div>
      </div>
      <div class="form-group">
        <label for="add-peca-comprada-por">Comprada por</label>
        <select id="add-peca-comprada-por">
          <option value="oficina">Oficina (entra no faturamento de peças)</option>
          <option value="cliente">Cliente (não entra no faturamento)</option>
        </select>
      </div>
      <button type="button" class="btn btn-secondary btn-add-item-confirmar" id="btn-confirmar-add-peca">Adicionar à OS</button>
    `;
  }

  function cablearFormAddPeca() {
    const selectCatalogo = document.getElementById('add-peca-catalogo');
    const inputDescricao = document.getElementById('add-peca-descricao');
    const inputQtd = document.getElementById('add-peca-qtd');
    const inputValor = document.getElementById('add-peca-valor');

    selectCatalogo.addEventListener('change', () => {
      const peca = state.pecasCatalogo.find((p) => p.id === Number(selectCatalogo.value));
      if (peca) {
        inputDescricao.value = peca.nome;
        inputValor.value = peca.precoVenda || 0;
      }
    });

    document.getElementById('btn-confirmar-add-peca').addEventListener('click', () => {
      const descricao = inputDescricao.value.trim();
      const marca = document.getElementById('add-peca-marca').value.trim();
      const codigo = document.getElementById('add-peca-codigo').value.trim();
      const quantidade = Number(inputQtd.value) || 0;
      const valorUnitario = Number(inputValor.value) || 0;
      const compradaPor = document.getElementById('add-peca-comprada-por').value === 'cliente' ? 'cliente' : 'oficina';

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
        id: OrdensDB.novoItemId(),
        pecaId,
        descricao,
        marca: marca || null,
        codigo: codigo || null,
        quantidade,
        valorUnitario,
        origem: pecaId ? 'catalogo' : 'manual',
        confirmada: true,
        compradaPor,
      });

      document.getElementById('os-form-add-peca').hidden = true;
      renderListaPecasForm();
    });
  }

  function montarFormAddMao() {
    const opcoesCatalogo = state.maoDeObraCatalogo
      .map((s) => `<option value="${s.id}">${escapeHtml(s.descricao)} (${formatarMoeda(s.valorPadrao)})</option>`)
      .join('');

    return `
      <div class="form-group">
        <label for="add-mao-catalogo">Serviço cadastrado <span class="form-optional">(opcional)</span></label>
        <select id="add-mao-catalogo">
          <option value="">Digitar manualmente</option>
          ${opcoesCatalogo}
        </select>
      </div>
      <div class="form-group">
        <label for="add-mao-descricao">Descrição</label>
        <input type="text" id="add-mao-descricao" maxlength="120" placeholder="Ex: Alinhamento e balanceamento" autocomplete="off">
      </div>
      <div class="form-group">
        <label for="add-mao-valor">Valor</label>
        <input type="number" id="add-mao-valor" min="0" step="0.01" value="0" inputmode="decimal">
      </div>
      <button type="button" class="btn btn-secondary btn-add-item-confirmar" id="btn-confirmar-add-mao">Adicionar à OS</button>
    `;
  }

  function cablearFormAddMao() {
    const selectCatalogo = document.getElementById('add-mao-catalogo');
    const inputDescricao = document.getElementById('add-mao-descricao');
    const inputValor = document.getElementById('add-mao-valor');

    selectCatalogo.addEventListener('change', () => {
      const servico = state.maoDeObraCatalogo.find((s) => s.id === Number(selectCatalogo.value));
      if (servico) {
        inputDescricao.value = servico.descricao;
        inputValor.value = servico.valorPadrao || 0;
      }
    });

    document.getElementById('btn-confirmar-add-mao').addEventListener('click', () => {
      const descricao = inputDescricao.value.trim();
      const valor = Number(inputValor.value) || 0;

      if (!descricao) {
        mostrarToast('Informe a descrição do serviço.', 'erro');
        return;
      }

      const maoDeObraId = selectCatalogo.value ? Number(selectCatalogo.value) : null;
      state.formMaoDeObra.push({
        id: OrdensDB.novoItemId(),
        maoDeObraId,
        descricao,
        valor,
        origem: maoDeObraId ? 'catalogo' : 'manual',
      });

      document.getElementById('os-form-add-mao').hidden = true;
      renderListaMaoForm();
    });
  }

  /** Re-renderiza a listinha de peças dentro do formulário e recalcula o total. */
  function renderListaPecasForm() {
    const container = document.getElementById('os-form-lista-pecas');
    if (!container) return;

    container.innerHTML = state.formPecas.length
      ? state.formPecas.map((item) => `
          <div class="os-item-row" data-id="${item.id}">
            <div class="os-item-info">
              <span class="os-item-descricao">
                ${escapeHtml(item.descricao)}
                ${item.origem === 'notinha' && !item.confirmada ? '<span class="badge-scanner">Lido da nota — revisar</span>' : ''}
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

  /** Re-renderiza as miniaturas das notas fiscais fixadas no formulário da OS. */
  function renderNotasFiscaisForm() {
    const container = document.getElementById('os-form-notas-fiscais');
    if (!container) return;

    container.innerHTML = state.formNotas.length
      ? `<p class="os-notas-titulo">Notas fiscais fixadas</p>` + state.formNotas.map((nota) => `
          <div class="os-nota-thumb" data-id="${nota.id}">
            <img src="${nota.dataUrl}" alt="Nota fiscal" data-abrir-nota="${nota.id}">
            <button type="button" class="os-item-remover" data-remover-nota="${nota.id}" aria-label="Remover nota fiscal">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
            </button>
          </div>
        `).join('')
      : '';

    container.querySelectorAll('[data-abrir-nota]').forEach((img) => {
      img.addEventListener('click', () => abrirNotaFiscalEmTelaCheia(img.src));
    });
    container.querySelectorAll('[data-remover-nota]').forEach((botao) => {
      botao.addEventListener('click', () => {
        state.formNotas = state.formNotas.filter((n) => n.id !== botao.dataset.removerNota);
        renderNotasFiscaisForm();
      });
    });
  }

  /** Abre uma imagem de nota fiscal em tela cheia numa nova aba, pra poder ler de novo. */
  function abrirNotaFiscalEmTelaCheia(dataUrl) {
    const janela = window.open('', '_blank');
    if (!janela) {
      mostrarToast('Não foi possível abrir a nota — verifique o bloqueio de pop-ups.', 'erro');
      return;
    }
    janela.document.write(`
      <title>Nota fiscal</title>
      <body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <img src="${dataUrl}" style="max-width:100%;max-height:100vh;">
      </body>
    `);
  }

  /** Re-renderiza a listinha de mão de obra dentro do formulário e recalcula o total. */
  function renderListaMaoForm() {
    const container = document.getElementById('os-form-lista-mao');
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
    const totalEl = document.getElementById('os-form-total');
    if (!totalEl) return;
    const total = OrdensDB.calcularValorTotal({
      pecasUtilizadas: state.formPecas,
      maoDeObraUtilizada: state.formMaoDeObra,
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
     Modal: formulário de criar/editar OS
     -------------------------------------------------------------------- */
  async function abrirFormulario(ordem = null) {
    const editando = Boolean(ordem);

    const [clientes, veiculos, pecasCatalogo, maoDeObraCatalogo] = await Promise.all([
      ClientesDB.listarTodos(),
      VeiculosDB.listarTodos(),
      PecasDB.listarTodas(),
      MaoDeObraDB.listarTodos(),
    ]);

    if (!clientes.length) {
      mostrarToast('Cadastre um cliente antes de abrir uma ordem de serviço.', 'erro');
      return;
    }

    state.clientes = clientes;
    state.veiculos = veiculos;
    state.pecasCatalogo = pecasCatalogo;
    state.maoDeObraCatalogo = maoDeObraCatalogo;
    state.formPecas = editando ? ordem.pecasUtilizadas.map((p) => ({ ...p })) : [];
    state.formMaoDeObra = editando ? ordem.maoDeObraUtilizada.map((m) => ({ ...m })) : [];
    state.formNotas = editando ? (ordem.notasFiscais || []).map((n) => ({ ...n })) : [];
    state.modalModo = 'formulario';
    state.modalOrdemId = editando ? ordem.id : null;

    const veiculoOptionsHtml = editando
      ? montarOpcoesVeiculos(veiculos, ordem.clienteId, ordem.veiculoId)
      : '<option value="">Selecione o cliente primeiro</option>';

    els.modalCorpo.innerHTML = `
      <form id="os-form" novalidate>
        <div class="form-group">
          <label for="campo-os-cliente">Cliente *</label>
          <select id="campo-os-cliente">
            <option value="">Selecione o cliente</option>
            ${montarOpcoesClientes(clientes, ordem?.clienteId)}
          </select>
        </div>
        <div class="form-group">
          <label for="campo-os-veiculo">Veículo *</label>
          <select id="campo-os-veiculo" ${editando ? '' : 'disabled'}>
            ${veiculoOptionsHtml}
          </select>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="campo-os-data">Data da OS</label>
            <input type="date" id="campo-os-data" value="${dataParaInputDate(ordem?.dataAbertura)}">
          </div>
          <div class="form-group">
            <label for="campo-os-status">Status</label>
            <select id="campo-os-status">
              ${Object.values(STATUS).map((s) => `
                <option value="${s}" ${(ordem?.status || STATUS.EM_ANDAMENTO) === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>
              `).join('')}
            </select>
          </div>
        </div>

        <div class="os-form-secao">
          <div class="os-form-secao-header">
            <h3>Peças</h3>
            <div class="os-form-secao-acoes">
              <button type="button" class="btn-add-item btn-ler-nota" id="btn-ler-nota-fiscal">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-1.6A1 1 0 0 1 9.35 5h5.3a1 1 0 0 1 .85.4L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.2"/></svg>
                Ler nota fiscal
              </button>
              <button type="button" class="btn-add-item" id="btn-abrir-add-peca">+ Adicionar</button>
            </div>
          </div>
          <div id="os-form-add-peca" class="os-add-item-form" hidden></div>
          <div id="os-form-lista-pecas" class="os-itens-lista"></div>
          <div id="os-form-notas-fiscais" class="os-notas-galeria"></div>
        </div>

        <div class="os-form-secao">
          <div class="os-form-secao-header">
            <h3>Mão de obra</h3>
            <button type="button" class="btn-add-item" id="btn-abrir-add-mao">+ Adicionar</button>
          </div>
          <p class="form-hint">A descrição de cada item de mão de obra é o que aparece como "Serviços realizados" na OS e no PDF.</p>
          <div id="os-form-add-mao" class="os-add-item-form" hidden></div>
          <div id="os-form-lista-mao" class="os-itens-lista"></div>
        </div>

        <div class="os-total-linha">
          <span>Valor total</span>
          <strong id="os-form-total">${formatarMoeda(0)}</strong>
        </div>

        <p class="form-erro" id="os-form-erro" hidden></p>
      </form>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-form-os">Cancelar</button>
      <button type="submit" form="os-form" class="btn btn-primary" id="btn-salvar-form-os">Salvar</button>
    `;

    const erroEl = document.getElementById('os-form-erro');

    // Cliente -> filtra o select de veículo
    document.getElementById('campo-os-cliente').addEventListener('change', (e) => {
      const clienteId = Number(e.target.value) || null;
      const veiculoSelect = document.getElementById('campo-os-veiculo');
      if (!clienteId) {
        veiculoSelect.innerHTML = '<option value="">Selecione o cliente primeiro</option>';
        veiculoSelect.disabled = true;
        return;
      }
      veiculoSelect.disabled = false;
      veiculoSelect.innerHTML = montarOpcoesVeiculos(state.veiculos, clienteId, null);
    });

    // Botões "+ Adicionar" de peça / mão de obra
    document.getElementById('btn-abrir-add-peca').addEventListener('click', () => {
      const container = document.getElementById('os-form-add-peca');
      const abrindo = container.hidden;
      container.hidden = !abrindo;
      if (abrindo) {
        container.innerHTML = montarFormAddPeca();
        cablearFormAddPeca();
      }
    });

    document.getElementById('btn-abrir-add-mao').addEventListener('click', () => {
      const container = document.getElementById('os-form-add-mao');
      const abrindo = container.hidden;
      container.hidden = !abrindo;
      if (abrindo) {
        container.innerHTML = montarFormAddMao();
        cablearFormAddMao();
      }
    });

    // Leitor de nota fiscal por IA: abre por cima deste formulário; ao
    // confirmar, os itens revisados entram direto em state.formPecas
    // (o usuário ainda precisa clicar em "Salvar" para gravar a OS).
    document.getElementById('btn-ler-nota-fiscal').addEventListener('click', () => {
      LeitorNotaFiscal.abrir({
        onConfirmar(itensLidos, meta) {
          const novosItens = itensLidos.map((item) => ({
            id: OrdensDB.novoItemId(),
            pecaId: null,
            compradaPor: 'oficina',
            ...item,
          }));
          state.formPecas = [...state.formPecas, ...novosItens];
          renderListaPecasForm();

          // Fixa a(s) foto(s) da nota na OS, pra poder abrir e conferir de
          // novo depois, sem precisar escanear tudo outra vez.
          const imagensDaNota = meta?.imagens || [];
          if (imagensDaNota.length) {
            state.formNotas = [
              ...state.formNotas,
              ...imagensDaNota.map((dataUrl) => ({ id: OrdensDB.novoItemId(), dataUrl, criadaEm: new Date().toISOString() })),
            ];
            renderNotasFiscaisForm();
          }

          mostrarToast(`${novosItens.length} peça(s) da nota fiscal lançada(s) — revise antes de salvar.`);
        },
      });
    });

    // Delegação de eventos para remover itens já adicionados
    document.getElementById('os-form-lista-pecas').addEventListener('click', (e) => {
      const botao = e.target.closest('[data-remover-peca]');
      if (!botao) return;
      state.formPecas = state.formPecas.filter((item) => item.id !== botao.dataset.removerPeca);
      renderListaPecasForm();
    });

    document.getElementById('os-form-lista-mao').addEventListener('click', (e) => {
      const botao = e.target.closest('[data-remover-mao]');
      if (!botao) return;
      state.formMaoDeObra = state.formMaoDeObra.filter((item) => item.id !== botao.dataset.removerMao);
      renderListaMaoForm();
    });

    renderListaPecasForm();
    renderListaMaoForm();
    renderNotasFiscaisForm();

    document.getElementById('btn-cancelar-form-os').addEventListener('click', fecharModal);

    document.getElementById('os-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      erroEl.hidden = true;

      const clienteId = Number(document.getElementById('campo-os-cliente').value) || null;
      const veiculoId = Number(document.getElementById('campo-os-veiculo').value) || null;
      const dataInput = document.getElementById('campo-os-data').value;
      const status = document.getElementById('campo-os-status').value;

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
        dataAbertura: inputDateParaIso(dataInput, ordem?.dataAbertura),
        pecasUtilizadas: state.formPecas,
        maoDeObraUtilizada: state.formMaoDeObra,
        notasFiscais: state.formNotas,
      };

      const botaoSalvar = document.getElementById('btn-salvar-form-os');
      botaoSalvar.disabled = true;

      try {
        if (editando) {
          await OrdensDB.atualizar(ordem.id, dados);
          mostrarToast('Ordem de serviço atualizada com sucesso.');
        } else {
          await OrdensDB.criar(dados);
          mostrarToast('Ordem de serviço criada com sucesso.');
        }
        fecharModal();
        await carregarOrdens();
      } catch (erro) {
        erroEl.textContent = erro.message || 'Não foi possível salvar a ordem de serviço.';
        erroEl.hidden = false;
        botaoSalvar.disabled = false;
      }
    });

    abrirModal(editando ? `Editar OS #${ordem.id}` : 'Nova Ordem de Serviço');
  }

  /* --------------------------------------------------------------------
     Modal: detalhe da OS
     -------------------------------------------------------------------- */
  async function abrirDetalhe(id) {
    const ordem = await OrdensDB.buscarPorId(id);
    if (!ordem) {
      mostrarToast('Esta ordem de serviço não foi encontrada.', 'erro');
      await carregarOrdens();
      return;
    }

    state.modalModo = 'detalhe';
    state.modalOrdemId = id;

    const [cliente, veiculo] = await Promise.all([
      ClientesDB.buscarPorId(ordem.clienteId),
      VeiculosDB.buscarPorId(ordem.veiculoId),
    ]);

    const linhasPecas = ordem.pecasUtilizadas.length
      ? ordem.pecasUtilizadas.map((item) => `
          <div class="os-item-row os-item-row-leitura">
            <div class="os-item-info">
              <span class="os-item-descricao">
                ${escapeHtml(item.descricao)}
                ${item.origem === 'notinha' && !item.confirmada ? '<span class="badge-scanner">Lido da nota — revisar</span>' : ''}
              </span>
              ${(item.marca || item.codigo) ? `<span class="os-item-marca-codigo">${escapeHtml([item.marca, item.codigo].filter(Boolean).join(' · '))}</span>` : ''}
              <span class="os-item-detalhe">${item.quantidade} × ${formatarMoeda(item.valorUnitario)}</span>
            </div>
            <span class="os-item-subtotal">${formatarMoeda(item.quantidade * item.valorUnitario)}</span>
          </div>
        `).join('')
      : '<p class="os-itens-vazio">Nenhuma peça lançada.</p>';

    const linhasMao = ordem.maoDeObraUtilizada.length
      ? ordem.maoDeObraUtilizada.map((item) => `
          <div class="os-item-row os-item-row-leitura">
            <span class="os-item-descricao">${escapeHtml(item.descricao)}</span>
            <span class="os-item-subtotal">${formatarMoeda(item.valor)}</span>
          </div>
        `).join('')
      : '<p class="os-itens-vazio">Nenhum serviço de mão de obra lançado.</p>';

    els.modalCorpo.innerHTML = `
      <div class="detalhe-os">
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Cliente</span>
          <span class="detalhe-valor">${escapeHtml(cliente?.nome || 'Não encontrado')}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Veículo</span>
          <span class="detalhe-valor">${escapeHtml(descreverVeiculo(veiculo))}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Status</span>
          <span class="status-badge status-badge-${ordem.status}">${STATUS_LABELS[ordem.status]}</span>
        </div>
        <div class="detalhe-linha">
          <span class="detalhe-rotulo">Aberta em</span>
          <span class="detalhe-valor">${formatarData(ordem.dataAbertura)}</span>
        </div>
        ${ordem.dataConclusao ? `
          <div class="detalhe-linha">
            <span class="detalhe-rotulo">Finalizada em</span>
            <span class="detalhe-valor">${formatarData(ordem.dataConclusao)}</span>
          </div>` : ''}
        ${ordem.dataEntrega ? `
          <div class="detalhe-linha">
            <span class="detalhe-rotulo">Entregue em</span>
            <span class="detalhe-valor">${formatarData(ordem.dataEntrega)}</span>
          </div>` : ''}
        <div class="detalhe-secao">
          <div class="os-form-secao-header">
            <h3 class="detalhe-secao-titulo">Checklist do serviço</h3>
            <span class="checklist-progresso" id="os-checklist-progresso"></span>
          </div>
          <ul class="checklist-lista" id="os-checklist-lista"></ul>
          <div class="chip-row" id="os-checklist-sugestoes"></div>
          <form id="form-add-checklist" class="checklist-add-form">
            <input type="text" id="input-checklist-item" maxlength="120" placeholder="Adicionar item ao checklist..." autocomplete="off">
            <button type="submit" class="btn-add-item">Adicionar</button>
          </form>
        </div>

        <div class="detalhe-secao">
          <h3 class="detalhe-secao-titulo">Peças</h3>
          ${linhasPecas}
        </div>
        <div class="detalhe-secao">
          <h3 class="detalhe-secao-titulo">Mão de obra</h3>
          ${linhasMao}
        </div>

        ${ordem.notasFiscais && ordem.notasFiscais.length ? `
        <div class="detalhe-secao">
          <h3 class="detalhe-secao-titulo">Notas fiscais</h3>
          <div class="os-notas-galeria" id="os-notas-fiscais-detalhe">
            ${ordem.notasFiscais.map((nota) => `
              <div class="os-nota-thumb" data-id="${nota.id}">
                <img src="${nota.dataUrl}" alt="Nota fiscal" data-abrir-nota-detalhe="${nota.id}">
                <button type="button" class="os-item-remover" data-remover-nota-detalhe="${nota.id}" aria-label="Remover nota fiscal">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
                </button>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        <div class="detalhe-secao">
          <div class="os-form-secao-header">
            <h3 class="detalhe-secao-titulo">Fotos do serviço</h3>
            <button type="button" class="btn-add-item" id="btn-abrir-add-foto">+ Adicionar foto</button>
          </div>
          <div id="os-add-foto-form" class="os-add-item-form" hidden></div>
          <div id="os-fotos-galeria" class="os-fotos-galeria">${montarGaleriaFotosHtml(ordem.fotos || [])}</div>
        </div>

        <div class="os-subtotais-linha">
          <span>Valor das peças</span>
          <span>${formatarMoeda(OrdensDB.calcularValorPecas(ordem))}</span>
        </div>
        <div class="os-subtotais-linha">
          <span>Valor da mão de obra</span>
          <span>${formatarMoeda(OrdensDB.calcularValorMaoDeObra(ordem))}</span>
        </div>
        <div class="os-total-linha">
          <span>Valor total</span>
          <strong>${formatarMoeda(ordem.valorTotal)}</strong>
        </div>
      </div>
    `;

    const botoesStatus = [];
    if (ordem.status === STATUS.EM_ANDAMENTO || ordem.status === STATUS.AGUARDANDO_PECAS) {
      botoesStatus.push('<button type="button" class="btn btn-primary" id="btn-finalizar-os">Finalizar OS</button>');
    } else if (ordem.status === STATUS.FINALIZADA) {
      botoesStatus.push('<button type="button" class="btn btn-primary" id="btn-entregar-os">Marcar como entregue</button>');
    }

    // OS já entregue não pode mais ser editada — evita alterar retroativamente
    // um serviço que o cliente já retirou e pagou. As demais ações
    // (duplicar, gerar PDF, excluir) continuam disponíveis normalmente.
    const podeEditar = ordem.status !== STATUS.ENTREGUE;

    els.modalRodape.innerHTML = `
      ${botoesStatus.join('')}
      <button type="button" class="btn btn-secondary" id="btn-duplicar-os">Duplicar</button>
      <button type="button" class="btn btn-secondary" id="btn-pdf-os">Gerar PDF</button>
      <button
        type="button"
        class="btn btn-secondary"
        id="btn-editar-os"
        ${podeEditar ? '' : 'disabled title="OS já entregue não pode mais ser editada"'}
      >Editar</button>
      <button type="button" class="btn btn-danger" id="btn-excluir-os">Excluir</button>
    `;

    const botaoFinalizar = document.getElementById('btn-finalizar-os');
    if (botaoFinalizar) {
      botaoFinalizar.addEventListener('click', async () => {
        botaoFinalizar.disabled = true;
        try {
          await OrdensDB.atualizarStatus(ordem.id, STATUS.FINALIZADA);
          mostrarToast('Ordem de serviço finalizada.');
          await carregarOrdens();
          await abrirDetalhe(ordem.id);
        } catch (erro) {
          mostrarToast(erro.message || 'Não foi possível finalizar a OS.', 'erro');
          botaoFinalizar.disabled = false;
        }
      });
    }

    const botaoEntregar = document.getElementById('btn-entregar-os');
    if (botaoEntregar) {
      botaoEntregar.addEventListener('click', async () => {
        botaoEntregar.disabled = true;
        try {
          await OrdensDB.atualizarStatus(ordem.id, STATUS.ENTREGUE);
          mostrarToast('Ordem de serviço marcada como entregue.');
          await carregarOrdens();
          await abrirDetalhe(ordem.id);
        } catch (erro) {
          mostrarToast(erro.message || 'Não foi possível atualizar a OS.', 'erro');
          botaoEntregar.disabled = false;
        }
      });
    }

    if (podeEditar) {
      document.getElementById('btn-editar-os').addEventListener('click', () => {
        fecharModal();
        abrirFormulario(ordem);
      });
    }

    document.getElementById('btn-excluir-os').addEventListener('click', () => {
      abrirConfirmacaoExclusao(ordem);
    });

    document.getElementById('btn-duplicar-os').addEventListener('click', async () => {
      const botao = document.getElementById('btn-duplicar-os');
      botao.disabled = true;
      try {
        const nova = await OrdensDB.duplicar(ordem.id);
        mostrarToast(`OS #${ordem.id} duplicada como OS #${nova.id}.`);
        fecharModal();
        await carregarOrdens();
        await abrirFormulario(await OrdensDB.buscarPorId(nova.id));
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível duplicar a ordem de serviço.', 'erro');
        botao.disabled = false;
      }
    });

    document.getElementById('btn-pdf-os').addEventListener('click', () => {
      gerarPdfOrdem(ordem, cliente, veiculo);
    });

    cablearSecaoChecklist(ordem);
    cablearSecaoFotos(ordem);

    document.querySelectorAll('[data-abrir-nota-detalhe]').forEach((img) => {
      img.addEventListener('click', () => abrirNotaFiscalEmTelaCheia(img.src));
    });
    document.querySelectorAll('[data-remover-nota-detalhe]').forEach((botao) => {
      botao.addEventListener('click', async () => {
        try {
          await OrdensDB.removerNotaFiscal(ordem.id, botao.dataset.removerNotaDetalhe);
          mostrarToast('Nota fiscal removida.');
          await abrirDetalhe(ordem.id);
        } catch (erro) {
          mostrarToast(erro.message || 'Não foi possível remover a nota fiscal.', 'erro');
        }
      });
    });

    abrirModal(`OS #${ordem.id}`);
  }

  /* --------------------------------------------------------------------
     Checklist: eventos da seção "Checklist do serviço" dentro do
     detalhe da OS (adicionar/remover itens, marcar/desmarcar como
     concluído). Diferente da seção de fotos, aqui a UI é atualizada só
     localmente (sem reconstruir o modal inteiro a cada clique) para o
     ato de marcar vários itens em sequência ser rápido — mas sempre
     mutando `ordem.checklist` diretamente, para que o botão de gerar
     PDF (que também usa essa mesma variável `ordem`) sempre veja os
     dados mais recentes sem precisar reabrir o detalhe.
     -------------------------------------------------------------------- */
  function cablearSecaoChecklist(ordem) {
    ordem.checklist = ordem.checklist || [];

    function renderChecklist() {
      const lista = document.getElementById('os-checklist-lista');
      const progresso = document.getElementById('os-checklist-progresso');
      const sugestoes = document.getElementById('os-checklist-sugestoes');
      if (!lista) return;

      const itens = ordem.checklist;
      const concluidos = itens.filter((i) => i.concluido).length;
      progresso.textContent = itens.length
        ? `${concluidos} de ${itens.length} concluído${itens.length > 1 ? 's' : ''}`
        : '';

      lista.innerHTML = itens.length ? itens.map((item) => `
        <li class="checklist-item ${item.concluido ? 'is-concluido' : ''}" data-item-id="${item.id}">
          <button type="button" class="checklist-checkbox" data-toggle-item="${item.id}" aria-pressed="${item.concluido}" aria-label="${item.concluido ? 'Marcar como pendente' : 'Marcar como concluído'}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 12l5 5L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <span class="checklist-texto">${escapeHtml(item.texto)}</span>
          <button type="button" class="checklist-remover" data-remover-item="${item.id}" aria-label="Remover item">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
          </button>
        </li>
      `).join('') : '<p class="os-itens-vazio">Nenhum item no checklist ainda.</p>';

      const textosExistentes = new Set(itens.map((i) => i.texto.trim().toLowerCase()));
      const disponiveis = SUGESTOES_CHECKLIST.filter((s) => !textosExistentes.has(s.trim().toLowerCase()));
      sugestoes.innerHTML = disponiveis.map((s) => `<button type="button" class="chip" data-sugestao="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
      sugestoes.hidden = disponiveis.length === 0;
    }

    async function adicionarItem(texto) {
      const textoLimpo = (texto || '').trim();
      if (!textoLimpo) return;
      try {
        const novoItem = await OrdensDB.adicionarItemChecklist(ordem.id, textoLimpo);
        ordem.checklist = [...ordem.checklist, novoItem];
        renderChecklist();
        await carregarOrdens();
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível adicionar o item.', 'erro');
      }
    }

    document.getElementById('form-add-checklist').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('input-checklist-item');
      const texto = input.value;
      input.value = '';
      await adicionarItem(texto);
      input.focus();
    });

    document.getElementById('os-checklist-sugestoes').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-sugestao]');
      if (chip) adicionarItem(chip.dataset.sugestao);
    });

    document.getElementById('os-checklist-lista').addEventListener('click', async (e) => {
      const botaoToggle = e.target.closest('[data-toggle-item]');
      if (botaoToggle) {
        const itemId = botaoToggle.dataset.toggleItem;
        const item = ordem.checklist.find((i) => i.id === itemId);
        if (!item) return;

        const valorAnterior = item.concluido;
        const dataAnterior = item.concluidoEm;
        item.concluido = !valorAnterior;
        item.concluidoEm = item.concluido ? new Date().toISOString() : null;
        renderChecklist();

        try {
          await OrdensDB.atualizarItemChecklist(ordem.id, itemId, { concluido: item.concluido });
          await carregarOrdens();
        } catch (erro) {
          item.concluido = valorAnterior;
          item.concluidoEm = dataAnterior;
          renderChecklist();
          mostrarToast(erro.message || 'Não foi possível atualizar o item.', 'erro');
        }
        return;
      }

      const botaoRemover = e.target.closest('[data-remover-item]');
      if (botaoRemover) {
        if (!confirm('Remover este item do checklist?')) return;
        const itemId = botaoRemover.dataset.removerItem;
        const listaAnterior = ordem.checklist;
        ordem.checklist = ordem.checklist.filter((i) => i.id !== itemId);
        renderChecklist();

        try {
          await OrdensDB.removerItemChecklist(ordem.id, itemId);
          await carregarOrdens();
        } catch (erro) {
          ordem.checklist = listaAnterior;
          renderChecklist();
          mostrarToast(erro.message || 'Não foi possível remover o item.', 'erro');
        }
      }
    });

    renderChecklist();
  }

  /* --------------------------------------------------------------------
     Fotos: eventos da seção "Fotos do serviço" dentro do detalhe da OS
     (abrir/fechar o formulário de captura, escolher momento, remover e
     ampliar fotos já salvas). Isolado numa função própria porque o
     detalhe é reconstruído do zero a cada chamada de abrirDetalhe().
     -------------------------------------------------------------------- */
  function cablearSecaoFotos(ordem) {
    const estadoFoto = {
      // Sugere "depois" quando a OS já está finalizada/entregue, e
      // "durante" nos demais status — o usuário pode trocar à vontade.
      momento: (ordem.status === STATUS.FINALIZADA || ordem.status === STATUS.ENTREGUE)
        ? MOMENTOS_FOTO.DEPOIS
        : MOMENTOS_FOTO.DURANTE,
      processando: false,
      pendente: null, // { dataUrl } depois que uma foto é escolhida, antes de salvar
    };

    function renderFormAddFoto() {
      const container = document.getElementById('os-add-foto-form');
      if (!container || container.hidden) return;

      const chips = Object.values(MOMENTOS_FOTO).map((m) => `
        <button type="button" class="chip ${estadoFoto.momento === m ? 'is-active' : ''}" data-momento="${m}">${MOMENTO_FOTO_LABELS[m]}</button>
      `).join('');

      if (estadoFoto.processando) {
        container.innerHTML = `
          <div class="chip-row">${chips}</div>
          <p class="os-itens-vazio">Preparando a foto...</p>
        `;
      } else if (estadoFoto.pendente) {
        container.innerHTML = `
          <div class="chip-row">${chips}</div>
          <img src="${estadoFoto.pendente.dataUrl}" class="foto-preview-pendente" alt="Pré-visualização da foto">
          <div class="form-group">
            <label for="input-legenda-foto">Legenda <span class="form-optional">(opcional)</span></label>
            <input type="text" id="input-legenda-foto" maxlength="140" placeholder="Ex: Pastilha gasta antes da troca" autocomplete="off">
          </div>
          <div class="foto-form-acoes">
            <button type="button" class="btn btn-secondary" id="btn-cancelar-foto">Cancelar</button>
            <button type="button" class="btn btn-primary" id="btn-confirmar-foto">Salvar foto</button>
          </div>
        `;
      } else {
        container.innerHTML = `
          <div class="chip-row">${chips}</div>
          <button type="button" class="btn-add-item btn-escolher-foto-btn" id="btn-escolher-foto">Tirar foto / Escolher da galeria</button>
          <input type="file" id="input-foto-os" accept="image/*" hidden>
        `;
      }

      container.querySelectorAll('[data-momento]').forEach((chip) => {
        chip.addEventListener('click', () => {
          estadoFoto.momento = chip.dataset.momento;
          renderFormAddFoto();
        });
      });

      const btnEscolher = document.getElementById('btn-escolher-foto');
      if (btnEscolher) {
        const inputFoto = document.getElementById('input-foto-os');
        btnEscolher.addEventListener('click', () => inputFoto.click());
        inputFoto.addEventListener('change', async () => {
          const arquivo = inputFoto.files[0];
          inputFoto.value = '';
          if (!arquivo) return;

          estadoFoto.processando = true;
          renderFormAddFoto();
          try {
            estadoFoto.pendente = await prepararFotoOS(arquivo);
          } catch (erro) {
            mostrarToast('Não foi possível carregar essa imagem. Tente outra foto.', 'erro');
          } finally {
            estadoFoto.processando = false;
            renderFormAddFoto();
          }
        });
      }

      const btnCancelar = document.getElementById('btn-cancelar-foto');
      if (btnCancelar) {
        btnCancelar.addEventListener('click', () => {
          estadoFoto.pendente = null;
          renderFormAddFoto();
        });
      }

      const btnConfirmar = document.getElementById('btn-confirmar-foto');
      if (btnConfirmar) {
        btnConfirmar.addEventListener('click', async () => {
          btnConfirmar.disabled = true;
          const legenda = document.getElementById('input-legenda-foto').value.trim();
          try {
            await OrdensDB.adicionarFoto(ordem.id, {
              dataUrl: estadoFoto.pendente.dataUrl,
              legenda: legenda || null,
              momento: estadoFoto.momento,
            });
            mostrarToast('Foto adicionada à OS.');
            await carregarOrdens();
            await abrirDetalhe(ordem.id);
          } catch (erro) {
            mostrarToast(erro.message || 'Não foi possível salvar a foto.', 'erro');
            btnConfirmar.disabled = false;
          }
        });
      }
    }

    document.getElementById('btn-abrir-add-foto').addEventListener('click', () => {
      const container = document.getElementById('os-add-foto-form');
      const abrindo = container.hidden;
      container.hidden = !abrindo;
      if (abrindo) {
        estadoFoto.pendente = null;
        estadoFoto.processando = false;
        renderFormAddFoto();
      }
    });

    document.getElementById('os-fotos-galeria').addEventListener('click', async (e) => {
      const botaoRemover = e.target.closest('[data-remover-foto]');
      if (botaoRemover) {
        if (!confirm('Remover esta foto da OS? Esta ação não pode ser desfeita.')) return;
        try {
          await OrdensDB.removerFoto(ordem.id, botaoRemover.dataset.removerFoto);
          mostrarToast('Foto removida.');
          await carregarOrdens();
          await abrirDetalhe(ordem.id);
        } catch (erro) {
          mostrarToast(erro.message || 'Não foi possível remover a foto.', 'erro');
        }
        return;
      }

      const thumb = e.target.closest('.os-foto-thumb');
      if (thumb) {
        const { achatada } = agruparFotosPorMomento(ordem.fotos || []);
        const indice = achatada.findIndex((f) => f.id === thumb.dataset.fotoId);
        if (indice >= 0) abrirVisualizadorFoto(achatada, indice, ordem.id);
      }
    });

    Utils.ativarCardComTeclado(document.getElementById('os-fotos-galeria'), '.os-foto-thumb');
  }

  /* --------------------------------------------------------------------
     Geração de PDF: monta um documento imprimível em uma nova janela e
     aciona o diálogo de impressão do navegador, de onde o usuário pode
     escolher "Salvar como PDF". Evita depender de bibliotecas externas.
     -------------------------------------------------------------------- */
  // Dados fixos da oficina, exibidos no cabeçalho do PDF da OS.
  const ENDERECO_OFICINA = 'Rua Emília, 11 — Jardim Gurilândia, Taubaté/SP';
  const TELEFONE_OFICINA = '(12) 97404-6305';

  async function gerarPdfOrdem(ordem, cliente, veiculo) {
    const janela = window.open('', '_blank');
    if (!janela) {
      mostrarToast('Não foi possível abrir a janela de impressão. Verifique o bloqueador de pop-ups.', 'erro');
      return;
    }

    const nomeOficina = (typeof ConfiguracoesDB !== 'undefined')
      ? await ConfiguracoesDB.obter('nomeOficina', 'Martins')
      : 'Martins';

    const linhasPecas = ordem.pecasUtilizadas.length
      ? ordem.pecasUtilizadas.map((item) => `
          <tr>
            <td>${escapeHtml(item.descricao)}${(item.marca || item.codigo) ? `<br><small>${escapeHtml([item.marca, item.codigo].filter(Boolean).join(' · '))}</small>` : ''}${item.compradaPor === 'cliente' ? '<br><small class="tag-cliente">Peça do cliente — não cobrada</small>' : ''}</td>
            <td class="col-num">${item.quantidade}</td>
            <td class="col-num">${formatarMoeda(item.valorUnitario)}</td>
            <td class="col-num">${formatarMoeda(item.quantidade * item.valorUnitario)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="4" class="col-vazio">Nenhuma peça lançada.</td></tr>';

    const linhasMao = ordem.maoDeObraUtilizada.length
      ? ordem.maoDeObraUtilizada.map((item) => `
          <tr>
            <td colspan="3">${escapeHtml(item.descricao)}</td>
            <td class="col-num">${formatarMoeda(item.valor)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="4" class="col-vazio">Nenhum serviço de mão de obra lançado.</td></tr>';

    // Fotos do serviço: agrupadas por momento (antes/durante/depois),
    // só entram no PDF as seções que realmente têm foto.
    const { grupos: gruposFotos } = agruparFotosPorMomento(ordem.fotos || []);
    const secaoFotosPdf = gruposFotos.length ? `
      <h2>Fotos do serviço</h2>
      ${gruposFotos.map((g) => `
        <h3 class="fotos-subtitulo">${g.titulo}</h3>
        <div class="fotos-grid">
          ${g.itens.map((f) => `
            <figure class="foto-item">
              <img src="${f.dataUrl}" alt="Foto do serviço">
              ${f.legenda ? `<figcaption>${escapeHtml(f.legenda)}</figcaption>` : ''}
            </figure>
          `).join('')}
        </div>
      `).join('')}
    ` : '';

    // Checklist do serviço: só entra no PDF se houver ao menos um item.
    const itensChecklist = ordem.checklist || [];
    const secaoChecklistPdf = itensChecklist.length ? `
      <h2>Checklist do serviço</h2>
      <ul class="checklist-pdf-lista">
        ${itensChecklist.map((item) => `
          <li class="checklist-pdf-item">
            <span class="checklist-pdf-caixa">${item.concluido ? '☑' : '☐'}</span>
            <span class="${item.concluido ? 'checklist-pdf-concluido' : ''}">${escapeHtml(item.texto)}</span>
          </li>
        `).join('')}
      </ul>
    ` : '';

    // Notas fiscais fixadas na OS: entram no PDF como imagens, pra servir
    // de comprovante junto com o documento.
    const secaoNotasPdf = (ordem.notasFiscais && ordem.notasFiscais.length) ? `
      <h2>Notas fiscais</h2>
      <div class="fotos-grid">
        ${ordem.notasFiscais.map((n) => `
          <figure class="foto-item">
            <img src="${n.dataUrl}" alt="Nota fiscal">
          </figure>
        `).join('')}
      </div>
    ` : '';

    const html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <title>OS #${ordem.id} · ${escapeHtml(nomeOficina)}</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: Arial, Helvetica, sans-serif; color: #1C1E22; padding: 32px; max-width: 780px; margin: 0 auto; }
          h1 { font-size: 22px; margin: 0; }
          .subtitulo { color: #555; font-size: 13px; margin-top: 2px; }
          .cabecalho { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1C1E22; padding-bottom: 12px; margin-bottom: 20px; }
          .os-numero-pdf { text-align: right; }
          .os-numero-pdf strong { font-size: 20px; display: block; }
          .grid-info { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin-bottom: 20px; font-size: 13px; }
          .grid-info div span { display: block; color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
          .grid-info div strong { font-size: 14px; }
          h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #ccc; padding-bottom: 6px; margin: 22px 0 8px; }
          p.descricao { font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid #e2e2e2; }
          th { font-size: 11px; text-transform: uppercase; color: #666; }
          .col-num { text-align: right; white-space: nowrap; }
          .col-vazio { text-align: center; color: #999; padding: 14px 6px; }
          .totais { margin-top: 16px; margin-left: auto; width: 260px; font-size: 13px; }
          .totais div { display: flex; justify-content: space-between; padding: 4px 0; }
          .totais .linha-total { border-top: 2px solid #1C1E22; margin-top: 6px; padding-top: 8px; font-size: 16px; font-weight: bold; }
          .endereco-oficina { color: #666; font-size: 11px; margin-top: 2px; }
          .tag-cliente { color: #a15c00; }
          .rodape { margin-top: 30px; font-size: 11px; color: #999; text-align: center; }
          .fotos-subtitulo { font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: #666; margin: 14px 0 8px; }
          .fotos-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 6px; }
          .foto-item { margin: 0; break-inside: avoid; }
          .foto-item img { width: 100%; height: 150px; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; display: block; }
          .foto-item figcaption { font-size: 11px; color: #555; margin-top: 3px; text-align: center; line-height: 1.3; }
          .checklist-pdf-lista { list-style: none; padding: 0; margin: 0 0 6px; columns: 2; column-gap: 24px; }
          .checklist-pdf-item { display: flex; align-items: baseline; gap: 6px; break-inside: avoid; padding: 3px 0; font-size: 13px; }
          .checklist-pdf-caixa { font-size: 14px; flex-shrink: 0; }
          .checklist-pdf-concluido { color: #888; text-decoration: line-through; }
          @media print { body { padding: 0 16px; } .foto-item { break-inside: avoid; } .checklist-pdf-item { break-inside: avoid; } }
        </style>
      </head>
      <body>
        <div class="cabecalho">
          <div>
            <h1>${escapeHtml(nomeOficina)}</h1>
            <p class="subtitulo">Ordem de Serviço</p>
            <p class="endereco-oficina">${escapeHtml(ENDERECO_OFICINA)} · ${escapeHtml(TELEFONE_OFICINA)}</p>
          </div>
          <div class="os-numero-pdf">
            <strong>OS #${ordem.id}</strong>
            <span class="subtitulo">${STATUS_LABELS[ordem.status]}</span>
          </div>
        </div>

        <div class="grid-info">
          <div><span>Cliente</span><strong>${escapeHtml(cliente?.nome || 'Não encontrado')}</strong></div>
          <div><span>Veículo</span><strong>${escapeHtml(descreverVeiculo(veiculo))}</strong></div>
          <div><span>Data de abertura</span><strong>${formatarData(ordem.dataAbertura)}</strong></div>
          ${ordem.dataConclusao ? `<div><span>Finalizada em</span><strong>${formatarData(ordem.dataConclusao)}</strong></div>` : ''}
          ${ordem.dataEntrega ? `<div><span>Entregue em</span><strong>${formatarData(ordem.dataEntrega)}</strong></div>` : ''}
        </div>

        ${secaoChecklistPdf}

        <h2>Peças utilizadas</h2>
        <table>
          <thead><tr><th>Descrição</th><th class="col-num">Qtd.</th><th class="col-num">Unit.</th><th class="col-num">Subtotal</th></tr></thead>
          <tbody>${linhasPecas}</tbody>
        </table>

        <h2>Mão de obra</h2>
        <table>
          <thead><tr><th colspan="3">Descrição</th><th class="col-num">Valor</th></tr></thead>
          <tbody>${linhasMao}</tbody>
        </table>

        ${secaoFotosPdf}

        ${secaoNotasPdf}

        <div class="totais">
          <div><span>Valor das peças</span><span>${formatarMoeda(OrdensDB.calcularValorPecas(ordem))}</span></div>
          <div><span>Valor da mão de obra</span><span>${formatarMoeda(OrdensDB.calcularValorMaoDeObra(ordem))}</span></div>
          <div class="linha-total"><span>Total</span><span>${formatarMoeda(ordem.valorTotal)}</span></div>
        </div>

        <p class="rodape">Documento gerado em ${new Date().toLocaleString('pt-BR')} · ${escapeHtml(nomeOficina)}</p>
      </body>
      </html>
    `;

    janela.document.open();
    janela.document.write(html);
    janela.document.close();
    janela.focus();

    setTimeout(() => {
      janela.print();
    }, 300);
  }

  /* --------------------------------------------------------------------
     Modal: confirmação de exclusão
     -------------------------------------------------------------------- */
  function abrirConfirmacaoExclusao(ordem) {
    state.modalModo = 'exclusao';

    els.modalCorpo.innerHTML = `
      <p class="confirmacao-texto">
        Tem certeza que deseja excluir a <strong>OS #${ordem.id}</strong>?
        Esta ação não pode ser desfeita.
      </p>
    `;

    els.modalRodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="btn-cancelar-exclusao-os">Cancelar</button>
      <button type="button" class="btn btn-danger" id="btn-confirmar-exclusao-os">Excluir</button>
    `;

    document.getElementById('btn-cancelar-exclusao-os').addEventListener('click', () => {
      fecharModal();
      abrirDetalhe(ordem.id);
    });

    document.getElementById('btn-confirmar-exclusao-os').addEventListener('click', async () => {
      const botao = document.getElementById('btn-confirmar-exclusao-os');
      botao.disabled = true;
      try {
        await OrdensDB.excluir(ordem.id);
        fecharModal();
        mostrarToast('Ordem de serviço excluída.');
        await carregarOrdens();
      } catch (erro) {
        mostrarToast(erro.message || 'Não foi possível excluir a ordem de serviço.', 'erro');
        botao.disabled = false;
      }
    });

    abrirModal('Excluir OS');
  }

  /* --------------------------------------------------------------------
     Lista principal (com busca e filtro por status)
     -------------------------------------------------------------------- */
  function renderLista() {
    if (!els.lista) return;

    if (state.carregando) {
      els.lista.innerHTML = `<p class="clientes-status">Carregando ordens de serviço...</p>`;
      return;
    }

    if (!state.ordens.length) {
      const mensagem = (state.termoBusca || state.filtroStatus !== 'todas')
        ? 'Nenhuma ordem de serviço encontrada para esse filtro.'
        : 'Nenhuma ordem de serviço aberta ainda. Toque em “Nova OS” para começar.';

      els.lista.innerHTML = `
        <div class="empty-state">
          <h2>Nada por aqui</h2>
          <p>${mensagem}</p>
        </div>
      `;
      return;
    }

    els.lista.innerHTML = state.ordens.map((ordem) => `
      <article class="os-card" data-id="${ordem.id}" role="button" tabindex="0">
        <div class="os-card-top">
          <span class="os-numero">OS #${ordem.id}</span>
          <span class="status-badge status-badge-${ordem.status}">${STATUS_LABELS[ordem.status]}</span>
        </div>
        <h3 class="os-cliente">${escapeHtml(ordem.cliente?.nome || 'Cliente não encontrado')}</h3>
        <p class="os-veiculo">${escapeHtml(descreverVeiculo(ordem.veiculo))}</p>
        <div class="os-card-bottom">
          <span class="os-data">${formatarData(ordem.dataAbertura)}</span>
          <span class="os-valor">${formatarMoeda(ordem.valorTotal)}</span>
        </div>
      </article>
    `).join('');
  }

  async function carregarOrdens() {
    state.carregando = true;
    renderLista();

    try {
      const [ordens, clientes, veiculos] = await Promise.all([
        OrdensDB.listarTodas(),
        ClientesDB.listarTodos(),
        VeiculosDB.listarTodos(),
      ]);

      const clientesPorId = new Map(clientes.map((c) => [c.id, c]));
      const veiculosPorId = new Map(veiculos.map((v) => [v.id, v]));

      let enriquecidas = ordens.map((ordem) => ({
        ...ordem,
        cliente: clientesPorId.get(ordem.clienteId) || null,
        veiculo: veiculosPorId.get(ordem.veiculoId) || null,
      }));

      if (state.filtroStatus !== 'todas') {
        enriquecidas = enriquecidas.filter((o) => o.status === state.filtroStatus);
      }

      const alvo = state.termoBusca.trim().toLowerCase();
      if (alvo) {
        enriquecidas = enriquecidas.filter((o) => {
          const nomeCliente = (o.cliente?.nome || '').toLowerCase();
          const placa = (o.veiculo?.placa || '').toLowerCase();
          const marcaModelo = [o.veiculo?.marca, o.veiculo?.modelo].filter(Boolean).join(' ').toLowerCase();
          const numeroOs = String(o.id);
          return nomeCliente.includes(alvo) || placa.includes(alvo) || marcaModelo.includes(alvo) || numeroOs.includes(alvo);
        });
      }

      state.ordens = enriquecidas;
    } catch (erro) {
      console.error('Erro ao carregar ordens de serviço:', erro);
      state.ordens = [];
      mostrarToast('Erro ao carregar a lista de ordens de serviço.', 'erro');
    } finally {
      state.carregando = false;
      renderLista();
    }
  }

  /* --------------------------------------------------------------------
     Montagem da tela (uma vez) e eventos
     -------------------------------------------------------------------- */
  function renderShell() {
    const root = document.getElementById('view-ordens');
    root.innerHTML = `
      <div class="ordens-view">
        <div class="view-toolbar">
          <div class="search-field">
            <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7"/>
              <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
            </svg>
            <input type="search" id="ordens-busca" placeholder="Buscar por cliente, placa ou nº da OS" autocomplete="off">
          </div>
          <div class="chip-row" id="ordens-filtros">
            <button type="button" class="chip is-active" data-status="todas">Todas</button>
            <button type="button" class="chip" data-status="${STATUS.EM_ANDAMENTO}">Em andamento</button>
            <button type="button" class="chip" data-status="${STATUS.AGUARDANDO_PECAS}">Aguardando peças</button>
            <button type="button" class="chip" data-status="${STATUS.FINALIZADA}">Finalizada</button>
            <button type="button" class="chip" data-status="${STATUS.ENTREGUE}">Entregue</button>
          </div>
        </div>
        <div class="ordens-lista" id="ordens-lista"></div>
      </div>
      <button type="button" class="fab" id="ordens-fab" aria-label="Nova ordem de serviço">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    els.lista = document.getElementById('ordens-lista');
    els.busca = document.getElementById('ordens-busca');
    els.filtros = document.getElementById('ordens-filtros');
    els.fab = document.getElementById('ordens-fab');
  }

  function bindEventos() {
    let timeoutBusca = null;
    els.busca.addEventListener('input', () => {
      clearTimeout(timeoutBusca);
      timeoutBusca = setTimeout(() => {
        state.termoBusca = els.busca.value;
        carregarOrdens();
      }, 200);
    });

    els.filtros.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      els.filtros.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      state.filtroStatus = chip.dataset.status;
      carregarOrdens();
    });

    els.fab.addEventListener('click', () => abrirFormulario());

    els.lista.addEventListener('click', (e) => {
      const card = e.target.closest('.os-card');
      if (card) {
        abrirDetalhe(Number(card.dataset.id));
      }
    });
    Utils.ativarCardComTeclado(els.lista, '.os-card');
  }

  /* --------------------------------------------------------------------
     Hook público para o futuro leitor de nota fiscal (notinhas).

     Quando essa funcionalidade existir, basta chamar:

       OrdensModule.receberPecasDoScanner(idDaOS, [
         { descricao: 'Filtro de óleo', quantidade: 1, valorUnitario: 32.9 },
         ...
       ]);

     As peças entram na OS marcadas para revisão (ver OrdensDB), e, se
     aquela mesma OS estiver aberta na tela (detalhe ou formulário) no
     momento em que o scanner terminar de ler, a tela é atualizada na
     hora para mostrar os itens recém-chegados.
     -------------------------------------------------------------------- */
  async function receberPecasDoScanner(ordemId, pecasLidas) {
    try {
      await OrdensDB.receberPecasDoScanner(ordemId, pecasLidas);
    } catch (erro) {
      console.error('Erro ao lançar peças da nota fiscal na OS:', erro);
      mostrarToast(erro.message || 'Não foi possível lançar as peças da nota fiscal nesta OS.', 'erro');
      return;
    }

    mostrarToast(`${pecasLidas.length} peça(s) da nota fiscal lançada(s) na OS #${ordemId}.`);

    if (state.modalOrdemId === ordemId) {
      if (state.modalModo === 'detalhe') {
        await abrirDetalhe(ordemId);
      } else if (state.modalModo === 'formulario') {
        const ordemAtualizada = await OrdensDB.buscarPorId(ordemId);
        state.formPecas = ordemAtualizada.pecasUtilizadas.map((p) => ({ ...p }));
        renderListaPecasForm();
      }
    }

    await carregarOrdens();
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
      carregarOrdens();
    },

    receberPecasDoScanner,

    /**
     * Ponto de entrada para outras telas (ex: Histórico do Cliente)
     * abrirem o detalhe completo de uma OS, com todas as ações
     * disponíveis (editar quando permitido, duplicar, gerar PDF, excluir).
     */
    abrirDetalhePorId(id) {
      return abrirDetalhe(id);
    },
  };
})();

App.modules.register(OrdensModule);
