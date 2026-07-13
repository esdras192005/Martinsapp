/* ======================================================================
   MARTINS — db/clientes.js
   Tabela: clientes

   Campos: id, nome, telefone, cpf, endereco, observacoes,
           createdAt (= data de cadastro), updatedAt

   Observação sobre formato: telefone e cpf são guardados só com os
   dígitos (sem máscara). Quem cuida de formatar para exibição (com
   parênteses, traço, pontos) é a camada de tela (js/modules/clientes.js),
   mantendo esta camada só com dados "crus" e fáceis de buscar/comparar.
   ====================================================================== */

const ClientesDB = (() => {
  const STORE = MartinsDB.STORES.CLIENTES;

  /** Mantém só os dígitos de uma string (telefone, cpf, etc.). */
  function apenasDigitos(valor) {
    return (valor || '').toString().replace(/\D/g, '');
  }

  /**
   * Cria um novo cliente.
   * @param {{nome: string, telefone: string, cpf?: string, endereco?: string, observacoes?: string}} dados
   */
  async function criar(dados) {
    const nome = dados?.nome?.trim();
    if (!nome) {
      throw new Error('O nome do cliente é obrigatório.');
    }

    // Telefone é opcional: se foi informado, precisa ser válido (com DDD);
    // se não foi informado, o cadastro segue sem ele.
    const telefone = apenasDigitos(dados.telefone);
    if (dados.telefone && (!telefone || telefone.length < 10)) {
      throw new Error('Informe um telefone válido, com DDD.');
    }

    const cpf = apenasDigitos(dados.cpf);
    if (cpf && cpf.length !== 11) {
      throw new Error('O CPF deve ter 11 dígitos.');
    }

    const cliente = MartinsDB.comCarimboDeCriacao({
      nome,
      telefone,
      cpf,
      endereco: dados.endereco?.trim() || '',
      observacoes: dados.observacoes?.trim() || '',
    });

    return MartinsDB.add(STORE, cliente);
  }

  /** Busca um cliente pelo id. */
  function buscarPorId(id) {
    return MartinsDB.get(STORE, id);
  }

  /** Lista todos os clientes, em ordem alfabética por nome. */
  async function listarTodos() {
    const clientes = await MartinsDB.getAll(STORE);
    return clientes.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  /** Busca clientes cujo nome contenha o termo informado (case-insensitive). */
  async function buscarPorNome(termo) {
    const clientes = await listarTodos();
    const alvo = termo.trim().toLowerCase();
    return clientes.filter((c) => c.nome.toLowerCase().includes(alvo));
  }

  /** Busca clientes por telefone (igualdade exata, só dígitos). */
  function buscarPorTelefone(telefone) {
    return MartinsDB.getAllByIndex(STORE, 'telefone', apenasDigitos(telefone));
  }

  /** Busca um cliente por CPF (igualdade exata, só dígitos). */
  function buscarPorCpf(cpf) {
    return MartinsDB.getByIndex(STORE, 'cpf', apenasDigitos(cpf));
  }

  /**
   * Pesquisa livre: casa o termo contra nome, telefone, cpf e endereço.
   * Usada pela barra de busca da tela de Clientes.
   */
  async function pesquisar(termo) {
    const clientes = await listarTodos();
    const alvoTexto = termo.trim().toLowerCase();
    const alvoDigitos = apenasDigitos(termo);

    if (!alvoTexto) return clientes;

    return clientes.filter((c) => {
      const casaNome = c.nome.toLowerCase().includes(alvoTexto);
      const casaEndereco = (c.endereco || '').toLowerCase().includes(alvoTexto);
      const casaTelefone = alvoDigitos && (c.telefone || '').includes(alvoDigitos);
      const casaCpf = alvoDigitos && (c.cpf || '').includes(alvoDigitos);
      return casaNome || casaEndereco || casaTelefone || casaCpf;
    });
  }

  /** Atualiza campos de um cliente existente. */
  function atualizar(id, dadosParciais) {
    const dados = { ...dadosParciais };

    if (dados.nome !== undefined) {
      dados.nome = dados.nome.trim();
    }
    if (dados.telefone !== undefined) {
      dados.telefone = apenasDigitos(dados.telefone);
    }
    if (dados.cpf !== undefined) {
      dados.cpf = apenasDigitos(dados.cpf);
    }
    if (dados.endereco !== undefined) {
      dados.endereco = dados.endereco.trim();
    }
    if (dados.observacoes !== undefined) {
      dados.observacoes = dados.observacoes.trim();
    }

    return MartinsDB.update(STORE, id, dados);
  }

  /**
   * Exclui um cliente.
   * Observação: a exclusão em cascata de veículos/ordens vinculadas
   * ainda não é feita aqui — é um ponto de atenção para quando as
   * telas de veículos/ordens estiverem prontas.
   */
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
    buscarPorNome,
    buscarPorTelefone,
    buscarPorCpf,
    pesquisar,
    atualizar,
    excluir,
    contar,
  };
})();
