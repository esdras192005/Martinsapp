/* ======================================================================
   MARTINS — db/veiculos.js
   Tabela: veiculos

   Campos: id, clienteId, placa, marca, modelo, ano, cor, km,
           observacoes, createdAt, updatedAt

   Todos os campos além de clienteId são opcionais — o cliente pode
   cadastrar o carro aos poucos, preenchendo só o que tiver em mãos.
   ====================================================================== */

const VeiculosDB = (() => {
  const STORE = MartinsDB.STORES.VEICULOS;

  /**
   * Cria um novo veículo, vinculado a um cliente.
   * @param {{clienteId: number, placa?: string, marca?: string, modelo?: string, ano?: number, cor?: string, km?: number, observacoes?: string}} dados
   */
  async function criar(dados) {
    if (!dados?.clienteId) {
      throw new Error('O veículo precisa estar vinculado a um clienteId.');
    }

    const placa = dados.placa?.trim().toUpperCase() || '';

    if (placa) {
      const placaExistente = await buscarPorPlaca(placa);
      if (placaExistente) {
        throw new Error(`Já existe um veículo cadastrado com a placa ${dados.placa}.`);
      }
    }

    const veiculo = MartinsDB.comCarimboDeCriacao({
      clienteId: dados.clienteId,
      // A placa só entra no objeto quando foi informada, para não
      // conflitar com o índice único quando vários veículos ficam
      // sem placa cadastrada.
      ...(placa ? { placa } : {}),
      marca: dados.marca?.trim() || '',
      modelo: dados.modelo?.trim() || '',
      ano: dados.ano || null,
      cor: dados.cor?.trim() || '',
      km: dados.km ?? null,
      observacoes: dados.observacoes?.trim() || '',
    });

    return MartinsDB.add(STORE, veiculo);
  }

  /** Busca um veículo pelo id. */
  function buscarPorId(id) {
    return MartinsDB.get(STORE, id);
  }

  /** Busca um veículo pela placa (índice único). */
  function buscarPorPlaca(placa) {
    return MartinsDB.getByIndex(STORE, 'placa', placa.trim().toUpperCase());
  }

  /** Lista todos os veículos de um cliente. */
  function listarPorCliente(clienteId) {
    return MartinsDB.getAllByIndex(STORE, 'clienteId', clienteId);
  }

  /** Lista todos os veículos cadastrados. */
  function listarTodos() {
    return MartinsDB.getAll(STORE);
  }

  /** Atualiza campos de um veículo existente. */
  function atualizar(id, dadosParciais) {
    if (dadosParciais.placa) {
      dadosParciais.placa = dadosParciais.placa.trim().toUpperCase();
    }
    return MartinsDB.update(STORE, id, dadosParciais);
  }

  /** Exclui um veículo. */
  function excluir(id) {
    return MartinsDB.remove(STORE, id);
  }

  function contar() {
    return MartinsDB.count(STORE);
  }

  return {
    criar,
    buscarPorId,
    buscarPorPlaca,
    listarPorCliente,
    listarTodos,
    atualizar,
    excluir,
    contar,
  };
})();
