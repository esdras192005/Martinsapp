/* ======================================================================
   MARTINS — db/configuracoes.js
   Tabela: configuracoes

   Armazenamento simples de chave-valor para preferências do app
   (ex: nome da oficina, moeda, tema, dados usados em impressões).

   Registro: { chave: string, valor: any, updatedAt }
   ====================================================================== */

const ConfiguracoesDB = (() => {
  const STORE = MartinsDB.STORES.CONFIGURACOES;

  /** Lê o valor de uma configuração; retorna valorPadrao se não existir. */
  async function obter(chave, valorPadrao = null) {
    const registro = await MartinsDB.get(STORE, chave);
    return registro ? registro.valor : valorPadrao;
  }

  /** Cria ou substitui o valor de uma configuração. */
  function definir(chave, valor) {
    return MartinsDB.put(STORE, { chave, valor, updatedAt: new Date().toISOString() });
  }

  /** Retorna todas as configurações como um objeto { chave: valor }. */
  async function obterTodas() {
    const registros = await MartinsDB.getAll(STORE);
    return registros.reduce((mapa, item) => {
      mapa[item.chave] = item.valor;
      return mapa;
    }, {});
  }

  /** Remove uma configuração. */
  function excluir(chave) {
    return MartinsDB.remove(STORE, chave);
  }

  /**
   * Garante valores padrão na primeira execução do app, sem sobrescrever
   * o que o usuário já tiver configurado depois.
   */
  async function seedPadrao() {
    const padroes = {
      nomeOficina: 'Martins',
      moeda: 'BRL',
      tema: 'escuro',
    };

    for (const [chave, valor] of Object.entries(padroes)) {
      const existente = await MartinsDB.get(STORE, chave);
      if (!existente) {
        await definir(chave, valor);
      }
    }
  }

  return {
    obter,
    definir,
    obterTodas,
    excluir,
    seedPadrao,
  };
})();
