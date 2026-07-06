/* ======================================================================
   MARTINS — db/ordens.js
   Tabela: ordensServico

   Campos: id, clienteId, veiculoId, status, dataAbertura,
           dataConclusao, dataEntrega, descricaoServicos,
           pecasUtilizadas, maoDeObraUtilizada, fotos, checklist,
           valorTotal, createdAt, updatedAt

   pecasUtilizadas: [{ id, pecaId, descricao, marca, codigo, quantidade,
                        valorUnitario, valorTotalLido, origem, confirmada }]
   maoDeObraUtilizada: [{ id, maoDeObraId, descricao, valor, origem }]

   fotos: [{ id, dataUrl, legenda, momento, criadaEm }]
     - `dataUrl` é a imagem já redimensionada/comprimida (JPEG) como
       data URL, pronta para <img src> tanto na tela quanto no PDF —
       sem depender de upload para nenhum servidor (o app é local/offline).
     - `legenda` é livre e opcional (null quando não preenchida).
     - `momento` indica a fase do serviço em que a foto foi tirada:
       'antes' | 'durante' | 'depois' (ver MOMENTOS_FOTO).
     - Registros de OS criados antes deste recurso simplesmente não têm
       o campo `fotos` (undefined) — tratado como lista vazia em todo
       lugar que a lê (não é preciso migrar o banco).

   checklist: [{ id, texto, concluido, concluidoEm, criadoEm }]
     - Lista de tarefas do serviço (ex: "Trocar óleo", "Testar freios"),
       livre e específica de cada OS — não existe um checklist "global"
       compartilhado entre ordens, cada uma tem a sua (é assim que o
       checklist fica "personalizado" por veículo/serviço, sem precisar
       de uma tela extra de templates). A tela oferece algumas sugestões
       rápidas (ver SUGESTOES_CHECKLIST em js/modules/ordens.js) só para
       agilizar a digitação, mas o usuário pode digitar qualquer item.
     - `concluido` (boolean) e `concluidoEm` (ISO string | null) marcam
       se/quando o item foi concluído durante o serviço.
     - Registros de OS anteriores a este recurso não têm o campo
       (undefined) — tratado como lista vazia em todo lugar que a lê.

   As linhas guardam uma cópia de descrição/valor no momento do uso
   (em vez de só o id) para que a ordem não mude retroativamente se
   o preço da peça ou do serviço for alterado depois no catálogo.

   `marca` e `codigo` são livres (texto), preenchidos manualmente ou
   pelo leitor de nota fiscal — não têm relação com o `codigo` único
   do catálogo (PecasDB), que é outra coisa.

   `valorTotalLido` guarda o valor total daquela linha exatamente como
   impresso na nota (quando existir), só para auditoria/comparação.
   O valor que efetivamente entra no total da OS é sempre recalculado
   como quantidade × valorUnitario (ver calcularValorTotal), nunca o
   valor lido — assim o total da OS nunca fica preso a uma leitura
   da IA que o mecânico não confirmou.

   `origem` de cada peça indica de onde ela veio:
     'manual'  -> digitada à mão no formulário da OS
     'catalogo'-> escolhida a partir do estoque (PecasDB)
     'notinha' -> lançada automaticamente pelo leitor de nota fiscal (IA)
   Peças com origem 'notinha' nascem com `confirmada: false`, para que
   a tela destaque que aquele valor/quantidade ainda não foi conferido
   por alguém da oficina (ver receberPecasDoScanner mais abaixo). O
   leitor de nota (js/modules/leitorNota.js) já deixa o usuário corrigir
   tudo antes de sequer chegar até aqui, mas o selo de revisão continua
   valendo até alguém confirmar explicitamente dentro da OS.

   Status possíveis:
   'em_andamento' | 'aguardando_pecas' | 'finalizada' | 'entregue'
   ====================================================================== */

const OrdensDB = (() => {
  const STORE = MartinsDB.STORES.ORDENS;

  const STATUS = {
    EM_ANDAMENTO: 'em_andamento',
    AGUARDANDO_PECAS: 'aguardando_pecas',
    FINALIZADA: 'finalizada',
    ENTREGUE: 'entregue',
  };

  const STATUS_LABELS = {
    [STATUS.EM_ANDAMENTO]: 'Em andamento',
    [STATUS.AGUARDANDO_PECAS]: 'Aguardando peças',
    [STATUS.FINALIZADA]: 'Finalizada',
    [STATUS.ENTREGUE]: 'Entregue',
  };

  const MOMENTOS_FOTO = {
    ANTES: 'antes',
    DURANTE: 'durante',
    DEPOIS: 'depois',
  };

  const MOMENTO_FOTO_LABELS = {
    [MOMENTOS_FOTO.ANTES]: 'Antes',
    [MOMENTOS_FOTO.DURANTE]: 'Durante',
    [MOMENTOS_FOTO.DEPOIS]: 'Depois',
  };

  /** Gera um id local simples para itens de peças/mão de obra dentro da OS. */
  function novoItemId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Calcula o valor total de uma ordem a partir das peças e da mão de
   * obra utilizadas. Função pura, não acessa o banco — útil também
   * na tela, antes de salvar (recalcular ao vivo enquanto o usuário
   * adiciona itens).
   */
  function calcularValorTotal(ordem) {
    return Number((calcularValorPecas(ordem) + calcularValorMaoDeObra(ordem)).toFixed(2));
  }

  /** Soma apenas o valor das peças de uma ordem (quantidade × valorUnitario). */
  function calcularValorPecas(ordem) {
    const total = (ordem.pecasUtilizadas || [])
      .reduce((soma, item) => soma + (Number(item.quantidade) || 0) * (Number(item.valorUnitario) || 0), 0);
    return Number(total.toFixed(2));
  }

  /** Soma apenas o valor da mão de obra de uma ordem. */
  function calcularValorMaoDeObra(ordem) {
    const total = (ordem.maoDeObraUtilizada || [])
      .reduce((soma, item) => soma + (Number(item.valor) || 0), 0);
    return Number(total.toFixed(2));
  }

  /** Normaliza uma lista de peças, garantindo id e campos consistentes. */
  function normalizarPecas(lista) {
    return (lista || []).map((item) => ({
      id: item.id || novoItemId(),
      pecaId: item.pecaId ?? null,
      descricao: (item.descricao || '').toString().trim() || 'Peça sem descrição',
      marca: (item.marca || '').toString().trim() || null,
      codigo: (item.codigo || '').toString().trim() || null,
      quantidade: Number(item.quantidade) || 1,
      valorUnitario: Number(item.valorUnitario) || 0,
      valorTotalLido: item.valorTotalLido != null ? Number(item.valorTotalLido) : null,
      origem: item.origem || 'manual',
      confirmada: item.confirmada ?? true,
    }));
  }

  /** Normaliza uma lista de mão de obra, garantindo id e campos consistentes. */
  function normalizarMaoDeObra(lista) {
    return (lista || []).map((item) => ({
      id: item.id || novoItemId(),
      maoDeObraId: item.maoDeObraId ?? null,
      descricao: (item.descricao || '').toString().trim() || 'Serviço sem descrição',
      valor: Number(item.valor) || 0,
      origem: item.origem || 'manual',
    }));
  }

  /** Normaliza uma lista de fotos, garantindo id, momento válido e campos consistentes. */
  function normalizarFotos(lista) {
    return (lista || []).map((item) => ({
      id: item.id || novoItemId(),
      dataUrl: item.dataUrl || '',
      legenda: (item.legenda || '').toString().trim() || null,
      momento: Object.values(MOMENTOS_FOTO).includes(item.momento) ? item.momento : MOMENTOS_FOTO.DURANTE,
      criadaEm: item.criadaEm || new Date().toISOString(),
    })).filter((item) => item.dataUrl); // descarta entradas sem imagem (defensivo)
  }

  /** Normaliza uma lista de itens de checklist, garantindo id e campos consistentes. */
  function normalizarChecklist(lista) {
    return (lista || []).map((item) => ({
      id: item.id || novoItemId(),
      texto: (item.texto || '').toString().trim(),
      concluido: Boolean(item.concluido),
      concluidoEm: item.concluido ? (item.concluidoEm || new Date().toISOString()) : null,
      criadoEm: item.criadoEm || new Date().toISOString(),
    })).filter((item) => item.texto); // descarta itens sem texto (defensivo)
  }

  /**
   * Integração com o Estoque (PecasDB): sempre que a lista de peças de
   * uma OS muda, o estoque precisa refletir isso automaticamente — só
   * peças vindas do catálogo (`pecaId` preenchido) afetam o estoque;
   * peças digitadas manualmente ou lidas de nota (sem vínculo com o
   * catálogo) não têm de onde debitar.
   *
   * Calcula, por pecaId, a diferença de quantidade entre a lista antiga
   * e a nova e aplica só o delta em PecasDB.ajustarEstoque — assim
   * editar uma OS várias vezes nunca desconta a mesma peça duas vezes.
   * Se uma peça do catálogo foi excluída do Estoque nesse meio tempo, o
   * ajuste daquele item é ignorado (a OS não pode falhar por isso).
   */
  async function sincronizarEstoque(pecasAntigas, pecasNovas) {
    if (typeof PecasDB === 'undefined') return; // segurança, caso o módulo não esteja carregado

    const somarPorPeca = (lista) => {
      const mapa = new Map();
      for (const item of lista || []) {
        if (!item.pecaId) continue;
        const atual = mapa.get(item.pecaId) || 0;
        mapa.set(item.pecaId, atual + (Number(item.quantidade) || 0));
      }
      return mapa;
    };

    const antigas = somarPorPeca(pecasAntigas);
    const novas = somarPorPeca(pecasNovas);
    const idsAfetados = new Set([...antigas.keys(), ...novas.keys()]);

    for (const pecaId of idsAfetados) {
      const delta = (antigas.get(pecaId) || 0) - (novas.get(pecaId) || 0);
      if (!delta) continue; // sem mudança de quantidade para essa peça
      try {
        // delta positivo (tinha mais antes) => devolve ao estoque;
        // delta negativo (tem mais agora) => desconta do estoque.
        await PecasDB.ajustarEstoque(pecaId, delta);
      } catch (erro) {
        console.warn(`Não foi possível ajustar o estoque da peça ${pecaId}:`, erro.message);
      }
    }
  }

  /**
   * Cria uma nova ordem de serviço.
   * @param {{clienteId: number, veiculoId: number, status?: string, dataAbertura?: string, descricaoServicos?: string, pecasUtilizadas?: array, maoDeObraUtilizada?: array}} dados
   */
  async function criar(dados) {
    if (!dados?.clienteId) {
      throw new Error('A ordem de serviço precisa de um cliente selecionado.');
    }
    if (!dados?.veiculoId) {
      throw new Error('A ordem de serviço precisa de um veículo selecionado.');
    }

    const pecasUtilizadas = normalizarPecas(dados.pecasUtilizadas);
    const maoDeObraUtilizada = normalizarMaoDeObra(dados.maoDeObraUtilizada);
    const fotos = normalizarFotos(dados.fotos);
    const checklist = normalizarChecklist(dados.checklist);

    const ordem = MartinsDB.comCarimboDeCriacao({
      clienteId: dados.clienteId,
      veiculoId: dados.veiculoId,
      status: dados.status || STATUS.EM_ANDAMENTO,
      dataAbertura: dados.dataAbertura || new Date().toISOString(),
      dataConclusao: null,
      dataEntrega: null,
      descricaoServicos: dados.descricaoServicos?.trim() || '',
      pecasUtilizadas,
      maoDeObraUtilizada,
      fotos,
      checklist,
      valorTotal: calcularValorTotal({ pecasUtilizadas, maoDeObraUtilizada }),
    });

    const criada = await MartinsDB.add(STORE, ordem);
    await sincronizarEstoque([], pecasUtilizadas);
    return criada;
  }

  /** Busca uma ordem pelo id. */
  function buscarPorId(id) {
    return MartinsDB.get(STORE, id);
  }

  /** Lista todas as ordens de serviço, mais recentes primeiro. */
  async function listarTodas() {
    const ordens = await MartinsDB.getAll(STORE);
    return ordens.sort((a, b) => new Date(b.dataAbertura) - new Date(a.dataAbertura));
  }

  /** Lista ordens por status (ver STATUS). */
  function listarPorStatus(status) {
    return MartinsDB.getAllByIndex(STORE, 'status', status);
  }

  /** Lista ordens de um cliente. */
  function listarPorCliente(clienteId) {
    return MartinsDB.getAllByIndex(STORE, 'clienteId', clienteId);
  }

  /** Lista ordens de um veículo. */
  function listarPorVeiculo(veiculoId) {
    return MartinsDB.getAllByIndex(STORE, 'veiculoId', veiculoId);
  }

  /**
   * Atualiza campos de uma ordem existente. Se peças ou mão de obra
   * forem alteradas, o valorTotal é recalculado automaticamente.
   */
  async function atualizar(id, dadosParciais) {
    const existente = await buscarPorId(id);
    if (!existente) {
      throw new Error(`Ordem de serviço com id ${id} não encontrada.`);
    }

    const mesclado = { ...existente, ...dadosParciais };

    if (dadosParciais.pecasUtilizadas) {
      mesclado.pecasUtilizadas = normalizarPecas(dadosParciais.pecasUtilizadas);
    }
    if (dadosParciais.maoDeObraUtilizada) {
      mesclado.maoDeObraUtilizada = normalizarMaoDeObra(dadosParciais.maoDeObraUtilizada);
    }
    if (dadosParciais.fotos) {
      mesclado.fotos = normalizarFotos(dadosParciais.fotos);
    }
    if (dadosParciais.checklist) {
      mesclado.checklist = normalizarChecklist(dadosParciais.checklist);
    }
    if (dadosParciais.descricaoServicos !== undefined) {
      mesclado.descricaoServicos = dadosParciais.descricaoServicos?.trim() || '';
    }
    if (dadosParciais.pecasUtilizadas || dadosParciais.maoDeObraUtilizada) {
      mesclado.valorTotal = calcularValorTotal(mesclado);
    }

    const atualizada = await MartinsDB.update(STORE, id, mesclado);

    if (dadosParciais.pecasUtilizadas) {
      await sincronizarEstoque(existente.pecasUtilizadas, mesclado.pecasUtilizadas);
    }

    return atualizada;
  }

  /**
   * Atalho para trocar apenas o status da ordem. Ao finalizar, grava a
   * data de conclusão; ao marcar como entregue, grava a data de entrega
   * (e a de conclusão também, caso a OS tenha pulado direto para entregue).
   */
  async function atualizarStatus(id, status) {
    const dados = { status };
    const agora = new Date().toISOString();

    if (status === STATUS.FINALIZADA) {
      dados.dataConclusao = agora;
    }
    if (status === STATUS.ENTREGUE) {
      dados.dataEntrega = agora;
      const existente = await buscarPorId(id);
      if (!existente?.dataConclusao) {
        dados.dataConclusao = agora;
      }
    }

    return atualizar(id, dados);
  }

  /**
   * Ponto de integração com o leitor de nota fiscal (notinhas).
   *
   * Quando o scanner ler uma nota, ele deve chamar esta função para
   * acrescentar as peças identificadas à OS já aberta, em vez de criar
   * uma ordem nova. As peças entram marcadas como `origem: 'notinha'`
   * e `confirmada: false`, para que a tela avise o mecânico que aquele
   * item ainda não foi conferido manualmente.
   *
   * @param {number} ordemId
   * @param {Array<{descricao?: string, nome?: string, quantidade?: number, valorUnitario?: number, valor?: number, pecaId?: number}>} pecasLidas
   */
  async function receberPecasDoScanner(ordemId, pecasLidas) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    if (!Array.isArray(pecasLidas) || !pecasLidas.length) {
      return ordem;
    }

    const novosItens = pecasLidas.map((p) => ({
      id: novoItemId(),
      pecaId: p.pecaId ?? null,
      descricao: (p.descricao || p.nome || 'Peça lida da nota fiscal').toString().trim(),
      marca: (p.marca || '').toString().trim() || null,
      codigo: (p.codigo || '').toString().trim() || null,
      quantidade: Number(p.quantidade) || 1,
      valorUnitario: Number(p.valorUnitario ?? p.valor) || 0,
      valorTotalLido: p.valorTotalLido != null ? Number(p.valorTotalLido) : null,
      origem: 'notinha',
      confirmada: false,
    }));

    const pecasUtilizadas = [...(ordem.pecasUtilizadas || []), ...novosItens];
    return atualizar(ordemId, { pecasUtilizadas });
  }

  /** Marca uma peça lida automaticamente como conferida pelo mecânico. */
  async function confirmarPeca(ordemId, itemId) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    const pecasUtilizadas = (ordem.pecasUtilizadas || []).map((item) =>
      item.id === itemId ? { ...item, confirmada: true } : item
    );
    return atualizar(ordemId, { pecasUtilizadas });
  }

  /**
   * Adiciona uma foto à OS (tirada/escolhida antes, durante ou depois do
   * serviço). A imagem já deve chegar pronta (redimensionada/comprimida
   * como data URL) — este módulo não lida com Canvas/captura, só persiste.
   * @param {number} ordemId
   * @param {{dataUrl: string, legenda?: string, momento?: string}} dadosFoto
   */
  async function adicionarFoto(ordemId, dadosFoto) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    if (!dadosFoto?.dataUrl) {
      throw new Error('Nenhuma imagem foi fornecida.');
    }

    const novaFoto = {
      id: novoItemId(),
      dataUrl: dadosFoto.dataUrl,
      legenda: (dadosFoto.legenda || '').toString().trim() || null,
      momento: Object.values(MOMENTOS_FOTO).includes(dadosFoto.momento) ? dadosFoto.momento : MOMENTOS_FOTO.DURANTE,
      criadaEm: new Date().toISOString(),
    };

    const fotos = [...(ordem.fotos || []), novaFoto];
    await atualizar(ordemId, { fotos });
    return novaFoto;
  }

  /** Remove uma foto da OS pelo id. */
  async function removerFoto(ordemId, fotoId) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    const fotos = (ordem.fotos || []).filter((f) => f.id !== fotoId);
    return atualizar(ordemId, { fotos });
  }

  /** Atualiza campos de uma foto já existente (hoje, só a legenda e o momento). */
  async function atualizarFoto(ordemId, fotoId, dadosParciais) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    const fotos = (ordem.fotos || []).map((f) => (f.id === fotoId ? { ...f, ...dadosParciais } : f));
    return atualizar(ordemId, { fotos });
  }

  /**
   * Adiciona um item ao checklist de tarefas da OS (ex: "Trocar óleo").
   * Nasce sempre como pendente (`concluido: false`) — o texto de um item
   * concluído no template de sugestões não afeta os já adicionados.
   * @param {number} ordemId
   * @param {string} texto
   */
  async function adicionarItemChecklist(ordemId, texto) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    const textoLimpo = (texto || '').toString().trim();
    if (!textoLimpo) {
      throw new Error('Descreva a tarefa do checklist.');
    }

    const novoItem = {
      id: novoItemId(),
      texto: textoLimpo,
      concluido: false,
      concluidoEm: null,
      criadoEm: new Date().toISOString(),
    };

    const checklist = [...(ordem.checklist || []), novoItem];
    await atualizar(ordemId, { checklist });
    return novoItem;
  }

  /** Remove um item do checklist pelo id. */
  async function removerItemChecklist(ordemId, itemId) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    const checklist = (ordem.checklist || []).filter((i) => i.id !== itemId);
    return atualizar(ordemId, { checklist });
  }

  /**
   * Atualiza um item do checklist (marcar/desmarcar como concluído, ou
   * corrigir o texto). Ao marcar como concluído, registra `concluidoEm`;
   * ao desmarcar, limpa essa data.
   */
  async function atualizarItemChecklist(ordemId, itemId, dadosParciais) {
    const ordem = await buscarPorId(ordemId);
    if (!ordem) {
      throw new Error(`Ordem de serviço com id ${ordemId} não encontrada.`);
    }
    const checklist = (ordem.checklist || []).map((item) => {
      if (item.id !== itemId) return item;
      const atualizado = { ...item, ...dadosParciais };
      if (dadosParciais.concluido !== undefined) {
        atualizado.concluidoEm = dadosParciais.concluido ? new Date().toISOString() : null;
      }
      return atualizado;
    });
    return atualizar(ordemId, { checklist });
  }

  /**
   * Duplica uma ordem de serviço existente, criando uma nova OS para o
   * mesmo cliente/veículo com a mesma descrição de serviços, peças e
   * mão de obra — pronta para o mecânico ajustar antes de salvar.
   *
   * A cópia sempre nasce com status "em_andamento", data de abertura de
   * hoje e sem data de conclusão/entrega, mesmo que a OS original já
   * tenha sido finalizada ou entregue. As fotos NÃO são copiadas — a
   * nova OS começa sem fotos, já que "antes/durante/depois" se refere
   * ao novo serviço, não ao registro visual do antigo. Já o CHECKLIST
   * é copiado (é a lista de tarefas do tipo de serviço, útil de
   * reaproveitar), mas todos os itens voltam para "pendente" — é um
   * serviço novo, ainda não executado.
   * @param {number} id
   */
  async function duplicar(id) {
    const original = await buscarPorId(id);
    if (!original) {
      throw new Error(`Ordem de serviço com id ${id} não encontrada.`);
    }

    return criar({
      clienteId: original.clienteId,
      veiculoId: original.veiculoId,
      status: STATUS.EM_ANDAMENTO,
      dataAbertura: new Date().toISOString(),
      descricaoServicos: original.descricaoServicos,
      pecasUtilizadas: (original.pecasUtilizadas || []).map((item) => ({
        ...item,
        id: undefined,
        origem: item.origem === 'notinha' ? 'manual' : item.origem,
        confirmada: true,
      })),
      maoDeObraUtilizada: (original.maoDeObraUtilizada || []).map((item) => ({
        ...item,
        id: undefined,
      })),
      checklist: (original.checklist || []).map((item) => ({
        ...item,
        id: undefined,
        concluido: false,
        concluidoEm: null,
        criadoEm: undefined,
      })),
    });
  }

  /**
   * Exclui uma ordem de serviço. Antes de apagar, devolve ao estoque
   * as peças do catálogo usadas nela (mesma lógica de sincronizarEstoque,
   * tratando a exclusão como "a OS passou a ter zero peças").
   */
  async function excluir(id) {
    const existente = await buscarPorId(id);
    if (existente) {
      await sincronizarEstoque(existente.pecasUtilizadas, []);
    }
    return MartinsDB.remove(STORE, id);
  }

  function contar() {
    return MartinsDB.count(STORE);
  }

  return {
    STATUS,
    STATUS_LABELS,
    MOMENTOS_FOTO,
    MOMENTO_FOTO_LABELS,
    calcularValorTotal,
    calcularValorPecas,
    calcularValorMaoDeObra,
    novoItemId,
    criar,
    buscarPorId,
    listarTodas,
    listarPorStatus,
    listarPorCliente,
    listarPorVeiculo,
    atualizar,
    atualizarStatus,
    receberPecasDoScanner,
    confirmarPeca,
    adicionarFoto,
    removerFoto,
    atualizarFoto,
    adicionarItemChecklist,
    removerItemChecklist,
    atualizarItemChecklist,
    duplicar,
    excluir,
    contar,
  };
})();
