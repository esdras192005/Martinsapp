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
              <span class="os
