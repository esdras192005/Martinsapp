/* ======================================================================
   MARTINS — db/pecas.js
   Tabela: pecas

   Campos: id, codigo, nome, categoria, unidade, precoCusto,
           precoVenda, quantidadeEstoque, estoqueMinimo,
           observacoes, createdAt, updatedAt
   ====================================================================== */

const PecasDB = (() => {
  const STORE = MartinsDB.STORES.PECAS;

  /**
   * Cria uma nova peça no catálogo/estoque.
   * @param {{codigo: string, nome: string, categoria?: string, unidade?: string, precoCusto?: number, precoVenda?: number, quantidadeEstoque?: number, estoqueMinimo?: number, observacoes?: string}} dados
   */
  async function criar(dados) {
    if (!dados?.codigo?.trim()) {
      throw new Error('O código da peça é obrigatório.');
    }
    if (!dados?.nome?.trim()) {
      throw new Error('O nome da peça é obrigatório.');
    }

    const codigoExistente = await buscarPorCodigo(dados.codigo.trim());
    if (codigoExistente) {
      throw new Error(`Já existe uma peça cadastrada com o código ${dados.codigo}.`);
    }

    const peca = MartinsDB.comCarimboDeCriacao({
      codigo: dados.codigo.trim(),
      nome: dados.nome.trim(),
      categoria: dados.categoria?.trim() || '',
      unidade: dados.unidade?.trim() || 'un',
      precoCusto: dados.precoCusto ?? 0,
      precoVenda: dados.precoVenda ?? 0,
      quantidadeEstoque: dados.quantidadeEstoque ?? 0,
      estoqueMinimo: dados.estoqueMinimo ?? 0,
      observacoes: dados.observacoes?.trim() || '',
    });

    return MartinsDB.add(STORE, peca);
  }

  /** Busca uma peça pelo id. */
  function buscarPorId(id) {
    return MartinsDB.get(STORE, id);
  }

  /** Busca uma peça pelo código (índice único). */
  function buscarPorCodigo(codigo) {
    return MartinsDB.getByIndex(STORE, 'codigo', codigo.trim());
  }

  /** Lista todas as peças. */
  function listarTodas() {
    return MartinsDB.getAll(STORE);
  }

  /** Lista peças de uma categoria específica. */
  function listarPorCategoria(categoria) {
    return MartinsDB.getAllByIndex(STORE, 'categoria', categoria);
  }

  /** Busca peças cujo nome contenha o termo informado. */
  async function buscarPorNome(termo) {
    const pecas = await listarTodas();
    const alvo = termo.trim().toLowerCase();
    return pecas.filter((p) => p.nome.toLowerCase().includes(alvo));
  }

  /** Lista peças com estoque igual ou abaixo do mínimo definido. */
  async function listarEstoqueBaixo() {
    const pecas = await listarTodas();
    return pecas.filter((p) => p.quantidadeEstoque <= p.estoqueMinimo);
  }

  /** Atualiza campos de uma peça existente. */
  function atualizar(id, dadosParciais) {
    return MartinsDB.update(STORE, id, dadosParciais);
  }

  /**
   * Ajusta o estoque de uma peça somando (ou subtraindo, com valor
   * negativo) a quantidade informada. Útil para dar entrada/saída
   * sem precisar reescrever a peça inteira.
   */
  async function ajustarEstoque(id, quantidadeDelta) {
    const peca = await buscarPorId(id);
    if (!peca) {
      throw new Error(`Peça com id ${id} não encontrada.`);
    }
    const novaQuantidade = Math.max(0, peca.quantidadeEstoque + quantidadeDelta);
    return atualizar(id, { quantidadeEstoque: novaQuantidade });
  }

  /** Exclui uma peça. */
  function excluir(id) {
    return MartinsDB.remove(STORE, id);
  }

  function contar() {
    return MartinsDB.count(STORE);
  }

  return {
    criar,
    buscarPorId,
    buscarPorCodigo,
    listarTodas,
    listarPorCategoria,
    buscarPorNome,
    listarEstoqueBaixo,
    atualizar,
    ajustarEstoque,
    excluir,
    contar,
  };
})();
