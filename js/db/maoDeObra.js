/* ======================================================================
   MARTINS — db/maoDeObra.js
   Tabela: maoDeObra

   Serviços de mão de obra que podem ser usados em ordens de serviço
   (ex: "Troca de óleo", "Alinhamento", "Revisão de freios").

   Campos: id, descricao, categoria, valorPadrao, tempoEstimadoMin,
           observacoes, createdAt, updatedAt
   ====================================================================== */

const MaoDeObraDB = (() => {
  const STORE = MartinsDB.STORES.MAO_DE_OBRA;

  /**
   * Cria um novo tipo de serviço de mão de obra.
   * @param {{descricao: string, categoria?: string, valorPadrao?: number, tempoEstimadoMin?: number, observacoes?: string}} dados
   */
  async function criar(dados) {
    if (!dados?.descricao?.trim()) {
      throw new Error('A descrição do serviço é obrigatória.');
    }

    const servico = MartinsDB.comCarimboDeCriacao({
      descricao: dados.descricao.trim(),
      categoria: dados.categoria?.trim() || '',
      valorPadrao: dados.valorPadrao ?? 0,
      tempoEstimadoMin: dados.tempoEstimadoMin ?? null,
      observacoes: dados.observacoes?.trim() || '',
    });

    return MartinsDB.add(STORE, servico);
  }

  /** Busca um serviço pelo id. */
  function buscarPorId(id) {
    return MartinsDB.get(STORE, id);
  }

  /** Lista todos os serviços de mão de obra cadastrados. */
  function listarTodos() {
    return MartinsDB.getAll(STORE);
  }

  /** Lista serviços de uma categoria específica. */
  function listarPorCategoria(categoria) {
    return MartinsDB.getAllByIndex(STORE, 'categoria', categoria);
  }

  /** Busca serviços cuja descrição contenha o termo informado. */
  async function buscarPorDescricao(termo) {
    const servicos = await listarTodos();
    const alvo = termo.trim().toLowerCase();
    return servicos.filter((s) => s.descricao.toLowerCase().includes(alvo));
  }

  /** Atualiza campos de um serviço existente. */
  function atualizar(id, dadosParciais) {
    return MartinsDB.update(STORE, id, dadosParciais);
  }

  /** Exclui um serviço de mão de obra. */
  function excluir(id) {
    return MartinsDB.remove(STORE, id);
  }

  function contar() {
    return MartinsDB.count(STORE);
  }

  return {
    criar,
    buscarPorId,
    listarTodos,
    listarPorCategoria,
    buscarPorDescricao,
    atualizar,
    excluir,
    contar,
  };
})();
