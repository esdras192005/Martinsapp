/* ======================================================================
   MARTINS — db/orcamentos.js
   Tabela: orcamentos

   Campos: id, clienteId, veiculoId, status, dataCriacao, validoAte,
           observacoes, pecas, maoDeObra, valorTotal,
           convertidoEmOrdemId, convertidoEm, createdAt, updatedAt

   Um orçamento NÃO é uma Ordem de Serviço: é uma proposta de valores
   para o cliente aprovar antes do serviço começar. Por isso ele tem
   sua própria tabela e seu próprio ciclo de vida (pendente / aprovado
   / recusado), em vez de reaproveitar o status da OS.

   pecas: [{ id, pecaId, descricao, marca, codigo, quantidade,
              valorUnitario, origem }]
   maoDeObra: [{ id, maoDeObraId, descricao, valor, origem }]

   Mesma lógica de "cópia no momento do uso" da OS: cada linha guarda
   descrição/valor no instante em que foi adicionada ao orçamento, para
   que ele não mude retroativamente se o preço mudar depois no catálogo.

   `origem` de cada peça/serviço indica de onde veio:
     'manual'   -> digitado à mão no formulário do orçamento
     'catalogo' -> escolhido a partir do estoque (PecasDB) ou da
                   tabela de mão de obra (MaoDeObraDB)

   Status possíveis: 'pendente' | 'aprovado' | 'recusado'

   Conversão em Ordem de Serviço (ver converterEmOrdem): cria uma OS
   nova via OrdensDB.criar com os mesmos cliente, veículo, peças, mão
   de obra e observações (viram a descrição dos serviços da OS) — nada
   se perde. O orçamento original não é apagado nem substituído: ele
   passa a guardar `convertidoEmOrdemId`/`convertidoEm` e seu status
   muda para "aprovado", mas continua existindo no histórico.
   ====================================================================== */

const OrcamentosDB = (() => {
  const STORE = MartinsDB.STORES.ORCAMENTOS;

  const STATUS = {
    PENDENTE: 'pendente',
    APROVADO: 'aprovado',
    RECUSADO: 'recusado',
  };

  const STATUS_LABELS = {
    [STATUS.PENDENTE]: 'Pendente',
    [STATUS.APROVADO]: 'Aprovado',
    [STATUS.RECUSADO]: 'Recusado',
  };

  /** Gera um id local simples para itens de peças/mão de obra dentro do orçamento. */
  function novoItemId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Calcula o valor total de um orçamento a partir das peças e da mão
   * de obra. Função pura, não acessa o banco — útil também na tela,
   * antes de salvar (recalcular ao vivo enquanto o usuário monta o
   * orçamento).
   */
  function calcularValorTotal(orcamento) {
    return Number((calcularValorPecas(orcamento) + calcularValorMaoDeObra(orcamento)).toFixed(2));
  }

  /** Soma apenas o valor das peças de um orçamento (quantidade × valorUnitario).
   * Peças marcadas como "compradaPor: cliente" não entram nesse total. */
  function calcularValorPecas(orcamento) {
    const total = (orcamento.pecas || [])
      .filter((item) => item.compradaPor !== 'cliente')
      .reduce((soma, item) => soma + (Number(item.quantidade) || 0) * (Number(item.valorUnitario) || 0), 0);
    return Number(total.toFixed(2));
  }

  /** Soma apenas o valor da mão de obra de um orçamento. */
  function calcularValorMaoDeObra(orcamento) {
    const total = (orcamento.maoDeObra || [])
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
      origem: item.origem || 'manual',
      // Quem comprou/vai comprar a peça: 'oficina' (padrão) ou 'cliente'
      // (não entra no faturamento de peças quando a OS for gerada).
      compradaPor: item.compradaPor === 'cliente' ? 'cliente' : 'oficina',
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

  /**
   * Cria um novo orçamento.
   * @param {{clienteId: number, veiculoId: number, status?: string, dataCriacao?: string, validoAte?: string|null, observacoes?: string, pecas?: array, maoDeObra?: array}} dados
   */
  async function criar(dados) {
    if (!dados?.clienteId) {
      throw new Error('O orçamento precisa de um cliente selecionado.');
    }
    if (!dados?.veiculoId) {
      throw new Error('O orçamento precisa de um veículo selecionado.');
    }

    const pecas = normalizarPecas(dados.pecas);
    const maoDeObra = normalizarMaoDeObra(dados.maoDeObra);

    const orcamento = MartinsDB.comCarimboDeCriacao({
      clienteId: dados.clienteId,
      veiculoId: dados.veiculoId,
      status: dados.status || STATUS.PENDENTE,
      dataCriacao: dados.dataCriacao || new Date().toISOString(),
      validoAte: dados.validoAte || null,
      observacoes: dados.observacoes?.trim() || '',
      pecas,
      maoDeObra,
      valorTotal: calcularValorTotal({ pecas, maoDeObra }),
      convertidoEmOrdemId: null,
      convertidoEm: null,
    });

    return MartinsDB.add(STORE, orcamento);
  }

  /** Busca um orçamento pelo id. */
  function buscarPorId(id) {
    return MartinsDB.get(STORE, id);
  }

  /** Lista todos os orçamentos (histórico completo), mais recentes primeiro. */
  async function listarTodos() {
    const orcamentos = await MartinsDB.getAll(STORE);
    return orcamentos.sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao));
  }

  /** Lista orçamentos por status (ver STATUS). */
  function listarPorStatus(status) {
    return MartinsDB.getAllByIndex(STORE, 'status', status);
  }

  /** Lista orçamentos de um cliente. */
  function listarPorCliente(clienteId) {
    return MartinsDB.getAllByIndex(STORE, 'clienteId', clienteId);
  }

  /** Lista orçamentos de um veículo. */
  function listarPorVeiculo(veiculoId) {
    return MartinsDB.getAllByIndex(STORE, 'veiculoId', veiculoId);
  }

  /**
   * Atualiza campos de um orçamento existente. Se peças ou mão de obra
   * forem alteradas, o valorTotal é recalculado automaticamente.
   * Permitido mesmo depois de convertido em OS — a edição aqui não
   * altera retroativamente a OS já gerada (cada uma guarda sua própria
   * cópia dos itens).
   */
  async function atualizar(id, dadosParciais) {
    const existente = await buscarPorId(id);
    if (!existente) {
      throw new Error(`Orçamento com id ${id} não encontrado.`);
    }

    const mesclado = { ...existente, ...dadosParciais };

    if (dadosParciais.pecas) {
      mesclado.pecas = normalizarPecas(dadosParciais.pecas);
    }
    if (dadosParciais.maoDeObra) {
      mesclado.maoDeObra = normalizarMaoDeObra(dadosParciais.maoDeObra);
    }
    if (dadosParciais.observacoes !== undefined) {
      mesclado.observacoes = dadosParciais.observacoes?.trim() || '';
    }
    if (dadosParciais.pecas || dadosParciais.maoDeObra) {
      mesclado.valorTotal = calcularValorTotal(mesclado);
    }

    return MartinsDB.update(STORE, id, mesclado);
  }

  /** Atalho para marcar o orçamento como Pendente, Aprovado ou Recusado. */
  function atualizarStatus(id, status) {
    if (!Object.values(STATUS).includes(status)) {
      throw new Error(`Status de orçamento inválido: ${status}`);
    }
    return atualizar(id, { status });
  }

  /**
   * Duplica um orçamento existente, criando um novo orçamento para o
   * mesmo cliente/veículo com as mesmas peças, mão de obra e
   * observações — pronto para o mecânico ajustar antes de salvar.
   *
   * A cópia sempre nasce com status "pendente", data de criação de
   * hoje, sem data de validade e sem vínculo de conversão, mesmo que o
   * orçamento original já tenha sido aprovado/recusado/convertido.
   * @param {number} id
   */
  async function duplicar(id) {
    const original = await buscarPorId(id);
    if (!original) {
      throw new Error(`Orçamento com id ${id} não encontrado.`);
    }

    return criar({
      clienteId: original.clienteId,
      veiculoId: original.veiculoId,
      status: STATUS.PENDENTE,
      dataCriacao: new Date().toISOString(),
      validoAte: null,
      observacoes: original.observacoes,
      pecas: (original.pecas || []).map((item) => ({ ...item, id: undefined })),
      maoDeObra: (original.maoDeObra || []).map((item) => ({ ...item, id: undefined })),
    });
  }

  /**
   * Converte um orçamento em uma Ordem de Serviço, com um único
   * clique, sem perder nenhuma informação: cliente, veículo, peças,
   * mão de obra e observações (viram a descrição dos serviços) são
   * copiados integralmente para a nova OS via OrdensDB.criar.
   *
   * O orçamento não é apagado — ele é marcado com o id da OS gerada
   * (`convertidoEmOrdemId`) e passa para o status "aprovado", mas
   * continua no histórico normalmente. Um orçamento só pode ser
   * convertido uma vez; para gerar outra OS a partir dos mesmos dados,
   * duplique o orçamento primeiro.
   *
   * @param {number} id
   * @returns {Promise<{orcamento: object, ordem: object}>}
   */
  async function converterEmOrdem(id) {
    const orcamento = await buscarPorId(id);
    if (!orcamento) {
      throw new Error(`Orçamento com id ${id} não encontrado.`);
    }
    if (orcamento.convertidoEmOrdemId) {
      throw new Error(`Este orçamento já foi convertido na OS #${orcamento.convertidoEmOrdemId}.`);
    }
    if (typeof OrdensDB === 'undefined') {
      throw new Error('Módulo de Ordens de Serviço indisponível para conversão.');
    }

    const ordem = await OrdensDB.criar({
      clienteId: orcamento.clienteId,
      veiculoId: orcamento.veiculoId,
      descricaoServicos: orcamento.observacoes,
      pecasUtilizadas: (orcamento.pecas || []).map((item) => ({ ...item, id: undefined, confirmada: true })),
      maoDeObraUtilizada: (orcamento.maoDeObra || []).map((item) => ({ ...item, id: undefined })),
    });

    const atualizado = await atualizar(id, {
      convertidoEmOrdemId: ordem.id,
      convertidoEm: new Date().toISOString(),
      status: STATUS.APROVADO,
    });

    return { orcamento: atualizado, ordem };
  }

  /** Exclui um orçamento. */
  function excluir(id) {
    return MartinsDB.remove(STORE, id);
  }

  function contar() {
    return MartinsDB.count(STORE);
  }

  return {
    STATUS,
    STATUS_LABELS,
    calcularValorTotal,
    calcularValorPecas,
    calcularValorMaoDeObra,
    novoItemId,
    criar,
    buscarPorId,
    listarTodos,
    listarPorStatus,
    listarPorCliente,
    listarPorVeiculo,
    atualizar,
    atualizarStatus,
    duplicar,
    converterEmOrdem,
    excluir,
    contar,
  };
})();
