/* ======================================================================
   MARTINS — Gestão de Oficina Mecânica
   db/database.js — núcleo do banco de dados local (IndexedDB)

   Este arquivo NÃO conhece regras de negócio de nenhuma entidade.
   Ele só sabe abrir o banco, criar as tabelas (object stores) e
   oferecer operações genéricas de CRUD que os módulos de cada
   entidade (clientes.js, veiculos.js, etc.) usam por baixo dos panos.

   Por que IndexedDB:
   - Nativo do navegador/WebView, sem dependências externas.
   - Assíncrono e não trava a interface em listas grandes.
   - Suporta índices, o que deixa buscas (por placa, status, etc.) rápidas.
   - Funciona offline, essencial para um app que também vira APK.
   ====================================================================== */

const MartinsDB = (() => {

  const DB_NAME = 'martinsDB';
  const DB_VERSION = 5;

  /**
   * Nomes das tabelas (object stores). Usar sempre estas constantes
   * em vez de strings soltas, para evitar erro de digitação.
   */
  const STORES = {
    CLIENTES: 'clientes',
    VEICULOS: 'veiculos',
    ORDENS: 'ordensServico',
    ORCAMENTOS: 'orcamentos',
    PECAS: 'pecas',
    MAO_DE_OBRA: 'maoDeObra',
    DESPESAS: 'despesas',
    CONFIGURACOES: 'configuracoes',
  };

  let dbInstance = null;
  let dbPromise = null;

  /* ----------------------------------------------------------------
     Criação / migração do esquema.

     Para adicionar uma nova tabela ou índice no futuro:
       1. Suba DB_VERSION em +1.
       2. Adicione o bloco correspondente aqui dentro, protegido por
          `if (!db.objectStoreNames.contains(...))`.
     O navegador chama onupgradeneeded automaticamente quando percebe
     que a versão mudou, sem apagar os dados já existentes.
     ---------------------------------------------------------------- */
  function criarEsquema(db, transaction) {
    if (!db.objectStoreNames.contains(STORES.CLIENTES)) {
      const store = db.createObjectStore(STORES.CLIENTES, { keyPath: 'id', autoIncrement: true });
      store.createIndex('nome', 'nome', { unique: false });
      store.createIndex('telefone', 'telefone', { unique: false });
      store.createIndex('email', 'email', { unique: false });
      store.createIndex('cpf', 'cpf', { unique: false });
    } else {
      // Banco já existia numa versão anterior: só acrescenta o índice novo,
      // sem mexer nos dados já gravados.
      const store = transaction.objectStore(STORES.CLIENTES);
      if (!store.indexNames.contains('cpf')) {
        store.createIndex('cpf', 'cpf', { unique: false });
      }
    }

    if (!db.objectStoreNames.contains(STORES.VEICULOS)) {
      const store = db.createObjectStore(STORES.VEICULOS, { keyPath: 'id', autoIncrement: true });
      store.createIndex('clienteId', 'clienteId', { unique: false });
      store.createIndex('placa', 'placa', { unique: true });
    }

    if (!db.objectStoreNames.contains(STORES.ORDENS)) {
      const store = db.createObjectStore(STORES.ORDENS, { keyPath: 'id', autoIncrement: true });
      store.createIndex('clienteId', 'clienteId', { unique: false });
      store.createIndex('veiculoId', 'veiculoId', { unique: false });
      store.createIndex('status', 'status', { unique: false });
      store.createIndex('dataAbertura', 'dataAbertura', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.ORCAMENTOS)) {
      const store = db.createObjectStore(STORES.ORCAMENTOS, { keyPath: 'id', autoIncrement: true });
      store.createIndex('clienteId', 'clienteId', { unique: false });
      store.createIndex('veiculoId', 'veiculoId', { unique: false });
      store.createIndex('status', 'status', { unique: false });
      store.createIndex('dataCriacao', 'dataCriacao', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.DESPESAS)) {
      const store = db.createObjectStore(STORES.DESPESAS, { keyPath: 'id', autoIncrement: true });
      store.createIndex('categoria', 'categoria', { unique: false });
      store.createIndex('status', 'status', { unique: false });
      store.createIndex('dataVencimento', 'dataVencimento', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.PECAS)) {
      const store = db.createObjectStore(STORES.PECAS, { keyPath: 'id', autoIncrement: true });
      // unique:true não impede várias peças sem código: quando a propriedade
      // `codigo` não é gravada no registro (undefined), o IndexedDB simplesmente
      // não inclui esse registro no índice — só nomes de código realmente
      // preenchidos precisam ser únicos entre si.
      store.createIndex('codigo', 'codigo', { unique: true });
      store.createIndex('nome', 'nome', { unique: false });
      store.createIndex('categoria', 'categoria', { unique: false });
      store.createIndex('fornecedor', 'fornecedor', { unique: false });
    } else {
      // Banco já existia em versão anterior (Estoque só tinha os campos
      // originais): acrescenta o índice de fornecedor sem apagar peças já
      // cadastradas. Os campos novos (marca, fornecedor) nascem undefined
      // nos registros antigos e passam a existir a partir da próxima edição.
      const store = transaction.objectStore(STORES.PECAS);
      if (!store.indexNames.contains('fornecedor')) {
        store.createIndex('fornecedor', 'fornecedor', { unique: false });
      }
    }

    if (!db.objectStoreNames.contains(STORES.MAO_DE_OBRA)) {
      const store = db.createObjectStore(STORES.MAO_DE_OBRA, { keyPath: 'id', autoIncrement: true });
      store.createIndex('descricao', 'descricao', { unique: false });
      store.createIndex('categoria', 'categoria', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.CONFIGURACOES)) {
      // Chave-valor simples: { chave: 'nomeOficina', valor: '...' }
      db.createObjectStore(STORES.CONFIGURACOES, { keyPath: 'chave' });
    }
  }

  /**
   * Abre a conexão com o banco (uma única vez — chamadas seguintes
   * reaproveitam a mesma instância).
   * @returns {Promise<IDBDatabase>}
   */
  function abrir() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB não é suportado neste ambiente.'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        criarEsquema(event.target.result, event.target.transaction);
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        dbPromise = null;
        reject(event.target.error);
      };

      request.onblocked = () => {
        console.warn('MartinsDB: abertura bloqueada por outra aba/conexão em versão antiga.');
      };
    });

    return dbPromise;
  }

  /** Transforma um IDBRequest em Promise. */
  function comoPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Adiciona um novo registro. Retorna o registro com o id gerado.
   * @param {string} storeName
   * @param {object} dados
   */
  async function add(storeName, dados) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readwrite');
    const id = await comoPromise(tx.objectStore(storeName).add(dados));
    return { ...dados, id };
  }

  /**
   * Cria ou substitui um registro por completo (precisa ter `id`).
   * Usado internamente por `update`.
   */
  async function put(storeName, dados) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readwrite');
    const id = await comoPromise(tx.objectStore(storeName).put(dados));
    return { ...dados, id };
  }

  /** Busca um registro pelo id (chave primária). */
  async function get(storeName, id) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readonly');
    const resultado = await comoPromise(tx.objectStore(storeName).get(id));
    return resultado ?? null;
  }

  /** Retorna todos os registros de uma tabela. */
  async function getAll(storeName) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readonly');
    return comoPromise(tx.objectStore(storeName).getAll());
  }

  /** Retorna o primeiro registro que bate com um valor de índice (útil para índices únicos). */
  async function getByIndex(storeName, indexName, valor) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readonly');
    const resultado = await comoPromise(tx.objectStore(storeName).index(indexName).get(valor));
    return resultado ?? null;
  }

  /** Retorna todos os registros que batem com um valor de índice. */
  async function getAllByIndex(storeName, indexName, valor) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readonly');
    return comoPromise(tx.objectStore(storeName).index(indexName).getAll(valor));
  }

  /** Atualiza parte de um registro existente (busca, mescla e grava). */
  async function update(storeName, id, dadosParciais) {
    const existente = await get(storeName, id);
    if (!existente) {
      throw new Error(`Registro com id ${id} não encontrado em "${storeName}".`);
    }
    const atualizado = tocar({ ...existente, ...dadosParciais, id });
    return put(storeName, atualizado);
  }

  /** Remove um registro pelo id. */
  async function remove(storeName, id) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readwrite');
    await comoPromise(tx.objectStore(storeName).delete(id));
    return true;
  }

  /** Conta quantos registros existem em uma tabela. */
  async function count(storeName) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readonly');
    return comoPromise(tx.objectStore(storeName).count());
  }

  /** Apaga todos os registros de uma tabela (usar com cautela). */
  async function clear(storeName) {
    const db = await abrir();
    const tx = db.transaction(storeName, 'readwrite');
    await comoPromise(tx.objectStore(storeName).clear());
    return true;
  }

  /** Acrescenta createdAt/updatedAt a um registro novo. */
  function comCarimboDeCriacao(dados) {
    const agora = new Date().toISOString();
    return { ...dados, createdAt: agora, updatedAt: agora };
  }

  /** Atualiza apenas o updatedAt de um registro. */
  function tocar(dados) {
    return { ...dados, updatedAt: new Date().toISOString() };
  }

  /**
   * Inicializa o banco. Deve ser chamado uma vez, no carregamento do app
   * (feito em app.js), antes de qualquer módulo de entidade ser usado.
   */
  async function init() {
    await abrir();
    console.info('MartinsDB: banco de dados pronto.');
  }

  return {
    STORES,
    init,
    add,
    put,
    get,
    getAll,
    getByIndex,
    getAllByIndex,
    update,
    remove,
    count,
    clear,
    comCarimboDeCriacao,
    tocar,
  };
})();
