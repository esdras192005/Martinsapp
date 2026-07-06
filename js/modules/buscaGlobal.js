/* ======================================================================
   MARTINS — modules/buscaGlobal.js
   Pesquisa Global

   Responsabilidade deste módulo:
   - Oferecer uma busca única, acessível de qualquer tela (botão de
     lupa no header), que cruza cliente, veículo, OS, orçamento e peça
     ao mesmo tempo, com resultado instantâneo enquanto o usuário digita.

   Este módulo NÃO substitui as pesquisas já existentes dentro de cada
   tela (Clientes, Estoque etc.) — elas continuam do jeito que estavam.
   É uma camada extra, só de leitura: lê os dados via *DB já existentes
   e, ao clicar num resultado, delega a abertura do detalhe para o
   módulo de tela responsável (ex: OrdensModule.abrirDetalhePorId).

   Segue o mesmo padrão de módulo dos demais arquivos em js/modules/,
   mas o `name` escolhido ('buscaGlobal') nunca bate com nenhum
   data-view existente, então App.modules.onNavigate nunca o aciona —
   ele só reage a cliques no botão do header.
   ====================================================================== */

const BuscaGlobalModule = (() => {

  const NOME_TELA = 'buscaGlobal';

  const { escapeHtml, mostrarToast } = Utils;

  /* --------------------------------------------------------------------
     Estado interno do módulo
     -------------------------------------------------------------------- */
  const state = {
    aberto: false,
    termo: '',
    filtro: 'todos',
    carregado: false,
    carregando: false,
    dados: {
      clientes: [],
      veiculos: [],
      ordens: [],
      orcamentos: [],
      pecas: [],
    },
    clientePorId: new Map(),
    veiculoPorId: new Map(),
  };

  const els = {};

  const CATEGORIAS = [
    { chave: 'todos', rotulo: 'Tudo' },
    { chave: 'clientes', rotulo: 'Clientes' },
    { chave: 'veiculos', rotulo: 'Veículos' },
    { chave: 'ordens', rotulo: 'Ordens' },
    { chave: 'orcamentos', rotulo: 'Orçamentos' },
    { chave: 'pecas', rotulo: 'Peças' },
  ];

  const TITULOS_GRUPO = {
    clientes: 'Clientes',
    veiculos: 'Veículos',
    ordens: 'Ordens de Serviço',
    orcamentos: 'Orçamentos',
    pecas: 'Peças em Estoque',
  };

  const ICONES = {
    clientes: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" stroke-linecap="round"/></svg>',
    veiculos: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 16.5v-3.2c0-.5.2-1 .5-1.4l1.8-2.3c.3-.4.8-.6 1.3-.6h8.8c.5 0 1 .2 1.3.6l1.8 2.3c.3.4.5.9.5 1.4v3.2" stroke-linejoin="round"/><rect x="3" y="16.5" width="18" height="3" rx="1"/><circle cx="7.5" cy="16.5" r="1.4"/><circle cx="16.5" cy="16.5" r="1.4"/></svg>',
    ordens: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="4" width="14" height="17" rx="1.5"/><path d="M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1Z"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" stroke-linecap="round"/></svg>',
    orcamentos: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5Z" stroke-linejoin="round"/><path d="M9 12.5h6M9 15.5h6M9 9.5h2.5" stroke-linecap="round"/></svg>',
    pecas: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7.5 12 4l8 3.5-8 3.5-8-3.5Z" stroke-linejoin="round"/><path d="M4 7.5V16l8 3.5 8-3.5V7.5" stroke-linejoin="round"/><path d="M12 11v8.5"/></svg>',
  };

  const LIMITE_POR_GRUPO = 8;

  /* --------------------------------------------------------------------
     Utilitários de texto: normalização (sem acento), escape de regex
     e destaque (highlight) do trecho encontrado.
     -------------------------------------------------------------------- */

  function normalizar(texto) {
    return (texto ?? '')
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function escapeRegExp(texto) {
    return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function corresponde(haystackNormalizado, termoNormalizado) {
    return !!termoNormalizado && haystackNormalizado.includes(termoNormalizado);
  }

  /** Escapa o texto e envolve em <mark> qualquer trecho igual ao termo digitado. */
  function destacar(texto, termoOriginal) {
    const seguro = escapeHtml(texto ?? '');
    const alvo = (termoOriginal ?? '').trim();
    if (!alvo) return seguro;
    const regex = new RegExp(escapeRegExp(alvo), 'gi');
    return seguro.replace(regex, (trecho) => `<mark class="busca-destaque">${trecho}</mark>`);
  }

  function juntar(...partes) {
    return partes.filter(Boolean).join(' ');
  }

  /* --------------------------------------------------------------------
     Montagem do overlay (uma vez só, reaproveitado a cada abertura)
     -------------------------------------------------------------------- */
  function montarOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'busca-global-overlay';
    overlay.id = 'busca-global-overlay';
    overlay.innerHTML = `
      <div class="busca-global-topo">
        <div class="search-field busca-global-campo">
          <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7"/>
            <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
          </svg>
          <input
            type="search"
            id="busca-global-input"
            placeholder="Cliente, placa, modelo, OS, orçamento ou peça"
            aria-label="Pesquisar em todo o aplicativo"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
          >
        </div>
        <button type="button" class="busca-global-cancelar" id="busca-global-cancelar">Cancelar</button>
      </div>
      <div class="chip-row busca-global-filtros" id="busca-global-filtros">
        ${CATEGORIAS.map((c) => `
          <button type="button" class="chip ${c.chave === 'todos' ? 'is-active' : ''}" data-filtro="${c.chave}">${c.rotulo}</button>
        `).join('')}
      </div>
      <div class="busca-global-resultados" id="busca-global-resultados"></div>
    `;
    document.body.appendChild(overlay);

    els.overlay = overlay;
    els.input = overlay.querySelector('#busca-global-input');
    els.filtros = overlay.querySelector('#busca-global-filtros');
    els.resultados = overlay.querySelector('#busca-global-resultados');
    els.cancelar = overlay.querySelector('#busca-global-cancelar');

    // Resultado instantâneo: recalcula a cada tecla, sem debounce —
    // os dados já estão todos em memória (ver carregarDados), então
    // filtrar de novo a cada tecla é praticamente imediato.
    els.input.addEventListener('input', () => {
      state.termo = els.input.value;
      renderResultados();
    });

    els.filtros.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      els.filtros.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      state.filtro = chip.dataset.filtro;
      renderResultados();
    });

    els.cancelar.addEventListener('click', fechar);

    els.resultados.addEventListener('click', (e) => {
      const item = e.target.closest('[data-acao]');
      if (!item) return;
      abrirRegistro(item.dataset.acao, Number(item.dataset.id));
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) fechar();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.aberto) fechar();
    });
  }

  /* --------------------------------------------------------------------
     Carregamento dos dados (uma leva só por abertura, reaproveitando
     as tabelas já existentes — nenhuma tabela/índice novo é criado).
     -------------------------------------------------------------------- */
  async function carregarDados() {
    if (state.carregando) return;
    state.carregando = true;
    try {
      const [clientes, veiculos, ordens, orcamentos, pecas] = await Promise.all([
        (typeof ClientesDB !== 'undefined') ? ClientesDB.listarTodos() : [],
        (typeof VeiculosDB !== 'undefined') ? VeiculosDB.listarTodos() : [],
        (typeof OrdensDB !== 'undefined') ? OrdensDB.listarTodas() : [],
        (typeof OrcamentosDB !== 'undefined') ? OrcamentosDB.listarTodos() : [],
        (typeof PecasDB !== 'undefined') ? PecasDB.listarTodas() : [],
      ]);

      state.dados.clientes = clientes || [];
      state.dados.veiculos = veiculos || [];
      state.dados.ordens = ordens || [];
      state.dados.orcamentos = orcamentos || [];
      state.dados.pecas = pecas || [];

      state.clientePorId = new Map(state.dados.clientes.map((c) => [c.id, c]));
      state.veiculoPorId = new Map(state.dados.veiculos.map((v) => [v.id, v]));

      state.carregado = true;
    } catch (erro) {
      console.error('Pesquisa global: falha ao carregar dados.', erro);
      mostrarToast('Não foi possível carregar os dados para pesquisa.', 'erro');
    } finally {
      state.carregando = false;
    }
  }

  /* --------------------------------------------------------------------
     Formatação leve, só para exibição no resultado (não reaproveita
     funções internas dos outros módulos, que ficam em closures privadas).
     -------------------------------------------------------------------- */
  function formatarTelefoneCurto(valor) {
    const d = (valor || '').toString().replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  }

  function descreverVeiculoCurto(veiculo) {
    if (!veiculo) return '';
    const partes = [veiculo.marca, veiculo.modelo].filter(Boolean).join(' ');
    return partes ? `${veiculo.placa} · ${partes}` : veiculo.placa;
  }

  /* --------------------------------------------------------------------
     Cálculo dos resultados: filtra cada tabela e monta os itens prontos
     para renderizar (ícone, título e subtítulo já com destaque aplicado).
     -------------------------------------------------------------------- */
  function calcularResultados() {
    const termoBruto = state.termo.trim();
    if (!termoBruto) {
      return { termo: '', grupos: [] };
    }

    const termoNorm = normalizar(termoBruto);

    const statusOrdemLabels = (typeof OrdensDB !== 'undefined') ? OrdensDB.STATUS_LABELS : {};
    const statusOrcamentoLabels = (typeof OrcamentosDB !== 'undefined') ? OrcamentosDB.STATUS_LABELS : {};

    /* --- Clientes: nome, telefone, CPF, endereço, observações --- */
    const clientesEncontrados = state.dados.clientes.filter((c) => corresponde(
      normalizar(juntar(c.nome, c.telefone, c.cpf, c.endereco, c.observacoes)),
      termoNorm,
    ));

    /* --- Veículos: placa, marca, modelo, cor + nome do dono --- */
    const veiculosEncontrados = state.dados.veiculos.filter((v) => {
      const dono = state.clientePorId.get(v.clienteId);
      return corresponde(
        normalizar(juntar(v.placa, v.marca, v.modelo, v.cor, dono?.nome)),
        termoNorm,
      );
    });

    /* --- Ordens de Serviço: número, status, descrição, peças usadas,
       além de cliente e placa do veículo (bate a OS pesquisando por
       quem é o dono ou qual o carro) --- */
    const ordensEncontradas = state.dados.ordens.filter((o) => {
      const cliente = state.clientePorId.get(o.clienteId);
      const veiculo = state.veiculoPorId.get(o.veiculoId);
      const pecasTexto = (o.pecasUtilizadas || [])
        .map((p) => juntar(p.descricao, p.codigo, p.marca))
        .join(' ');
      const haystack = normalizar(juntar(
        `OS ${o.id}`,
        `#${o.id}`,
        statusOrdemLabels[o.status],
        o.descricaoServicos,
        pecasTexto,
        cliente?.nome,
        veiculo?.placa,
        veiculo?.modelo,
        veiculo?.marca,
      ));
      return corresponde(haystack, termoNorm);
    });

    /* --- Orçamentos: número, status, observações, peças, cliente, placa --- */
    const orcamentosEncontrados = state.dados.orcamentos.filter((o) => {
      const cliente = state.clientePorId.get(o.clienteId);
      const veiculo = state.veiculoPorId.get(o.veiculoId);
      const pecasTexto = (o.pecas || [])
        .map((p) => juntar(p.descricao, p.codigo, p.marca))
        .join(' ');
      const haystack = normalizar(juntar(
        `orcamento ${o.id}`,
        `#${o.id}`,
        statusOrcamentoLabels[o.status],
        o.observacoes,
        pecasTexto,
        cliente?.nome,
        veiculo?.placa,
        veiculo?.modelo,
      ));
      return corresponde(haystack, termoNorm);
    });

    /* --- Peças em estoque: nome, código, categoria, marca, fornecedor --- */
    const pecasEncontradas = state.dados.pecas.filter((p) => corresponde(
      normalizar(juntar(p.nome, p.codigo, p.categoria, p.marca, p.fornecedor, p.observacoes)),
      termoNorm,
    ));

    const grupos = [
      {
        chave: 'clientes',
        total: clientesEncontrados.length,
        itens: clientesEncontrados.slice(0, LIMITE_POR_GRUPO).map((c) => ({
          acao: 'cliente',
          id: c.id,
          icone: ICONES.clientes,
          titulo: destacar(c.nome, termoBruto),
          subtitulo: destacar(formatarTelefoneCurto(c.telefone), termoBruto),
        })),
      },
      {
        chave: 'veiculos',
        total: veiculosEncontrados.length,
        itens: veiculosEncontrados.slice(0, LIMITE_POR_GRUPO).map((v) => {
          const dono = state.clientePorId.get(v.clienteId);
          return {
            acao: 'veiculo',
            id: v.clienteId,
            icone: ICONES.veiculos,
            titulo: destacar(descreverVeiculoCurto(v), termoBruto),
            subtitulo: dono ? destacar(dono.nome, termoBruto) : 'Cliente não encontrado',
          };
        }),
      },
      {
        chave: 'ordens',
        total: ordensEncontradas.length,
        itens: ordensEncontradas.slice(0, LIMITE_POR_GRUPO).map((o) => {
          const cliente = state.clientePorId.get(o.clienteId);
          const veiculo = state.veiculoPorId.get(o.veiculoId);
          return {
            acao: 'ordem',
            id: o.id,
            icone: ICONES.ordens,
            titulo: destacar(`OS #${o.id}`, termoBruto),
            subtitulo: destacar([statusOrdemLabels[o.status], cliente?.nome, veiculo?.placa].filter(Boolean).join(' · '), termoBruto),
          };
        }),
      },
      {
        chave: 'orcamentos',
        total: orcamentosEncontrados.length,
        itens: orcamentosEncontrados.slice(0, LIMITE_POR_GRUPO).map((o) => {
          const cliente = state.clientePorId.get(o.clienteId);
          const veiculo = state.veiculoPorId.get(o.veiculoId);
          return {
            acao: 'orcamento',
            id: o.id,
            icone: ICONES.orcamentos,
            titulo: destacar(`Orçamento #${o.id}`, termoBruto),
            subtitulo: destacar([statusOrcamentoLabels[o.status], cliente?.nome, veiculo?.placa].filter(Boolean).join(' · '), termoBruto),
          };
        }),
      },
      {
        chave: 'pecas',
        total: pecasEncontradas.length,
        itens: pecasEncontradas.slice(0, LIMITE_POR_GRUPO).map((p) => ({
          acao: 'peca',
          id: p.id,
          icone: ICONES.pecas,
          titulo: destacar(p.nome, termoBruto),
          subtitulo: destacar([p.codigo ? `#${p.codigo}` : null, p.marca, p.categoria].filter(Boolean).join(' · '), termoBruto),
        })),
      },
    ];

    return { termo: termoBruto, grupos };
  }

  /* --------------------------------------------------------------------
     Renderização
     -------------------------------------------------------------------- */
  const SVG_SETA = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function templateItem(item) {
    return `
      <button type="button" class="busca-resultado-item" data-acao="${item.acao}" data-id="${item.id}">
        <span class="busca-resultado-icone" aria-hidden="true">${item.icone}</span>
        <span class="busca-resultado-texto">
          <span class="busca-resultado-titulo">${item.titulo}</span>
          <span class="busca-resultado-subtitulo">${item.subtitulo || '—'}</span>
        </span>
        <span class="busca-resultado-seta" aria-hidden="true">${SVG_SETA}</span>
      </button>
    `;
  }

  function templateVazio() {
    return `
      <div class="busca-global-vazio">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="11" cy="11" r="7"/>
          <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
        </svg>
        <p>Nenhum resultado para "${escapeHtml(state.termo.trim())}". Tente outro nome, placa ou número.</p>
      </div>
    `;
  }

  function templateDica() {
    return `
      <div class="busca-global-dica">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="11" cy="11" r="7"/>
          <path d="m21 21-4.3-4.3" stroke-linecap="round"/>
        </svg>
        <p>Pesquise por nome do cliente, placa, modelo do veículo, número da OS, orçamento ou peça.</p>
      </div>
    `;
  }

  function renderResultados() {
    const { termo, grupos } = calcularResultados();

    if (!termo) {
      els.resultados.innerHTML = templateDica();
      return;
    }

    const gruposVisiveis = grupos.filter((g) => (
      (state.filtro === 'todos' || state.filtro === g.chave) && g.itens.length > 0
    ));

    if (gruposVisiveis.length === 0) {
      els.resultados.innerHTML = templateVazio();
      return;
    }

    els.resultados.innerHTML = gruposVisiveis.map((g) => `
      <section class="busca-global-grupo">
        ${state.filtro === 'todos' ? `<h3 class="busca-global-grupo-titulo">${TITULOS_GRUPO[g.chave]} (${g.total})</h3>` : ''}
        <div class="busca-global-lista">
          ${g.itens.map(templateItem).join('')}
        </div>
      </section>
    `).join('');
  }

  /* --------------------------------------------------------------------
     Navegação: ao escolher um resultado, muda para a view certa e
     delega a abertura do detalhe ao módulo responsável por aquela tela.
     -------------------------------------------------------------------- */
  function abrirRegistro(acao, id) {
    fechar();

    switch (acao) {
      case 'cliente':
        App.navigateTo('clientes');
        if (typeof ClientesModule !== 'undefined' && ClientesModule.abrirDetalhePorId) {
          ClientesModule.abrirDetalhePorId(id);
        }
        break;

      case 'veiculo':
        // O veículo não tem tela própria: seu detalhe vive dentro do
        // cadastro do cliente dono dele.
        if (!id) {
          mostrarToast('Este veículo não está vinculado a um cliente.', 'erro');
          return;
        }
        App.navigateTo('clientes');
        if (typeof ClientesModule !== 'undefined' && ClientesModule.abrirDetalhePorId) {
          ClientesModule.abrirDetalhePorId(id);
        }
        break;

      case 'ordem':
        App.navigateTo('ordens');
        if (typeof OrdensModule !== 'undefined' && OrdensModule.abrirDetalhePorId) {
          OrdensModule.abrirDetalhePorId(id);
        }
        break;

      case 'orcamento':
        App.navigateTo('orcamentos');
        if (typeof OrcamentosModule !== 'undefined' && OrcamentosModule.abrirDetalhePorId) {
          OrcamentosModule.abrirDetalhePorId(id);
        }
        break;

      case 'peca':
        App.navigateTo('estoque');
        if (typeof EstoqueModule !== 'undefined' && EstoqueModule.abrirDetalhePorId) {
          EstoqueModule.abrirDetalhePorId(id);
        }
        break;

      default:
        break;
    }
  }

  /* --------------------------------------------------------------------
     Abrir / fechar o overlay
     -------------------------------------------------------------------- */
  async function abrir() {
    state.aberto = true;
    els.overlay.classList.add('is-open');
    document.body.classList.add('modal-aberto');
    els.resultados.innerHTML = templateDica();

    // Recarrega os dados a cada abertura, para refletir qualquer
    // cadastro/edição feita desde a última pesquisa.
    await carregarDados();
    if (state.termo) renderResultados();

    els.input.focus();
  }

  function fechar() {
    state.aberto = false;
    els.overlay.classList.remove('is-open');
    if (!document.querySelector('.modal-overlay.is-open')) {
      document.body.classList.remove('modal-aberto');
    }
    els.input.value = '';
    state.termo = '';
    state.filtro = 'todos';
    els.filtros.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filtro === 'todos'));
  }

  function bindBotaoHeader() {
    const botao = document.getElementById('btn-busca-global');
    if (botao) {
      botao.addEventListener('click', abrir);
    }
  }

  /* --------------------------------------------------------------------
     API pública do módulo (padrão exigido por App.modules)
     -------------------------------------------------------------------- */
  return {
    name: NOME_TELA,

    init() {
      montarOverlay();
      bindBotaoHeader();
    },
  };
})();

App.modules.register(BuscaGlobalModule);
