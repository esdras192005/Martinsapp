/* ======================================================================
   MARTINS — db/despesas.js
   Tabela: despesas

   Registro manual das despesas fixas e variáveis da oficina (aluguel,
   ferramentas, energia, água, internet, impostos, outras). É o lado
   "saída" do módulo Financeiro — o lado "entrada" não precisa de
   tabela própria, pois é derivado diretamente das Ordens de Serviço
   concluídas (ver js/modules/financeiro.js).

   Campos: id, descricao, categoria, valor, dataVencimento,
           dataPagamento, status, observacoes, createdAt, updatedAt

   status: 'pendente' (ainda não paga) | 'pago' (já paga). O campo é
   guardado explicitamente (em vez de só inferir de dataPagamento) para
   permitir indexar e filtrar rapidamente as "contas a pagar" do
   dashboard.
   ====================================================================== */

const DespesasDB = (() => {
  const STORE = MartinsDB.STORES.DESPESAS;

  const CATEGORIAS = {
    ALUGUEL: 'aluguel',
    FERRAMENTAS: 'ferramentas',
    ENERGIA: 'energia',
    AGUA: 'agua',
    INTERNET: 'internet',
    IMPOSTOS: 'impostos',
    OUTRAS: 'outras',
  };

  const CATEGORIA_LABELS = {
    [CATEGORIAS.ALUGUEL]: 'Aluguel',
    [CATEGORIAS.FERRAMENTAS]: 'Ferramentas',
    [CATEGORIAS.ENERGIA]: 'Energia',
    [CATEGORIAS.AGUA]: 'Água',
    [CATEGORIAS.INTERNET]: 'Internet',
    [CATEGORIAS.IMPOSTOS]: 'Impostos',
    [CATEGORIAS.OUTRAS]: 'Outras',
  };

  const STATUS = {
    PENDENTE: 'pendente',
    PAGO: 'pago',
  };

  const STATUS_LABELS = {
    [STATUS.PENDENTE]: 'Pendente',
    [STATUS.PAGO]: 'Pago',
  };

  /** Soma o valor de uma lista de despesas. Função pura, não acessa o banco. */
  function calcularTotal(lista) {
    const total = (lista || []).reduce((soma, item) => soma + (Number(item.valor) || 0), 0);
    return Number(total.toFixed(2));
  }

  /** Uma despesa pendente é considerada vencida quando a data de vencimento já passou. */
  function estaVencida(despesa) {
    if (despesa.status !== STATUS.PENDENTE || !despesa.dataVencimento) return false;
    return new Date(despesa.dataVencimento) < new Date(new Date().toDateString());
  }

  /**
   * Cria uma nova despesa.
   * @param {{descricao: string, categoria: string, valor: number, dataVencimento: string, dataPagamento?: string|null, observacoes?: string}} dados
   */
  async function criar(dados) {
    const descricao = dados?.descricao?.toString().trim();
    if (!descricao) {
      throw new Error('Informe a descrição da despesa.');
    }
    if (!Object.values(CATEGORIAS).includes(dados?.categoria)) {
      throw new Error('Selecione uma categoria válida para a despesa.');
    }
    const valor = Number(dados?.valor);
    if (!valor || valor <= 0) {
      throw new Error('Informe um valor maior que zero.');
    }
    if (!dados?.dataVencimento) {
      throw new Error('Informe a data de vencimento da despesa.');
    }

    const dataPagamento = dados.dataPagamento || null;

    const despesa = MartinsDB.comCarimboDeCriacao({
      descricao,
      categoria: dados.categoria,
      valor,
      dataVencimento: dados.dataVencimento,
      dataPagamento,
      status: dataPagamento ? STATUS.PAGO : STATUS.PENDENTE,
      observacoes: dados.observacoes?.trim() || '',
    });

    return MartinsDB.add(STORE, despesa);
  }

  /** Busca uma despesa pelo id. */
  function buscarPorId(id) {
    return MartinsDB.get(STORE, id);
  }

  /** Lista todas as despesas, mais recentes (por vencimento) primeiro. */
  async function listarTodas() {
    const despesas = await MartinsDB.getAll(STORE);
    return despesas.sort((a, b) => new Date(b.dataVencimento) - new Date(a.dataVencimento));
  }

  /** Lista despesas por status ('pendente' | 'pago'). */
  function listarPorStatus(status) {
    return MartinsDB.getAllByIndex(STORE, 'status', status);
  }

  /** Lista despesas por categoria. */
  function listarPorCategoria(categoria) {
    return MartinsDB.getAllByIndex(STORE, 'categoria', categoria);
  }

  /**
   * Lista as despesas já pagas cuja data de pagamento cai dentro do
   * intervalo [inicioIso, fimIso] — usado pelo dashboard para calcular
   * o total de despesas realizadas em um período (mês, ano etc.).
   */
  async function listarPagasNoPeriodo(inicioIso, fimIso) {
    const todas = await listarTodas();
    const inicio = new Date(inicioIso);
    const fim = new Date(fimIso);
    return todas.filter((d) => {
      if (d.status !== STATUS.PAGO || !d.dataPagamento) return false;
      const data = new Date(d.dataPagamento);
      return data >= inicio && data <= fim;
    });
  }

  /**
   * Lista todas as contas a pagar (status pendente), ordenadas pela
   * data de vencimento mais próxima primeiro — é a lista usada no
   * card "Contas a pagar" do dashboard.
   */
  async function listarPendentes() {
    const pendentes = await listarPorStatus(STATUS.PENDENTE);
    return pendentes.sort((a, b) => new Date(a.dataVencimento) - new Date(b.dataVencimento));
  }

  /** Atualiza campos de uma despesa existente. */
  async function atualizar(id, dadosParciais) {
    const existente = await buscarPorId(id);
    if (!existente) {
      throw new Error(`Despesa com id ${id} não encontrada.`);
    }

    const mesclado = { ...existente, ...dadosParciais };

    if (dadosParciais.descricao !== undefined) {
      mesclado.descricao = dadosParciais.descricao?.trim();
    }
    if (dadosParciais.observacoes !== undefined) {
      mesclado.observacoes = dadosParciais.observacoes?.trim() || '';
    }
    if (dadosParciais.valor !== undefined) {
      mesclado.valor = Number(dadosParciais.valor) || 0;
    }
    // Mantém o status coerente com a presença (ou não) de data de pagamento,
    // a não ser que o status tenha sido explicitamente informado.
    if (dadosParciais.dataPagamento !== undefined && dadosParciais.status === undefined) {
      mesclado.status = dadosParciais.dataPagamento ? STATUS.PAGO : STATUS.PENDENTE;
    }

    return MartinsDB.update(STORE, id, mesclado);
  }

  /** Marca uma despesa como paga, com a data de pagamento informada (padrão: hoje). */
  function marcarComoPago(id, dataPagamentoIso) {
    return atualizar(id, {
      status: STATUS.PAGO,
      dataPagamento: dataPagamentoIso || new Date().toISOString(),
    });
  }

  /** Reabre uma despesa já paga, voltando para "pendente" (limpa a data de pagamento). */
  function marcarComoPendente(id) {
    return atualizar(id, { status: STATUS.PENDENTE, dataPagamento: null });
  }

  /**
   * Duplica uma despesa para o mês seguinte — atalho útil para contas
   * fixas recorrentes (aluguel, internet etc.), sem precisar de um
   * motor de repetição automática: a cópia nasce pendente, com o
   * vencimento avançado em um mês e sem data de pagamento.
   */
  async function duplicarParaProximoMes(id) {
    const original = await buscarPorId(id);
    if (!original) {
      throw new Error(`Despesa com id ${id} não encontrada.`);
    }

    const novoVencimento = new Date(original.dataVencimento);
    novoVencimento.setMonth(novoVencimento.getMonth() + 1);

    return criar({
      descricao: original.descricao,
      categoria: original.categoria,
      valor: original.valor,
      dataVencimento: novoVencimento.toISOString(),
      dataPagamento: null,
      observacoes: original.observacoes,
    });
  }

  /** Exclui uma despesa. */
  function excluir(id) {
    return MartinsDB.remove(STORE, id);
  }

  function contar() {
    return MartinsDB.count(STORE);
  }

  return {
    CATEGORIAS,
    CATEGORIA_LABELS,
    STATUS,
    STATUS_LABELS,
    calcularTotal,
    estaVencida,
    criar,
    buscarPorId,
    listarTodas,
    listarPorStatus,
    listarPorCategoria,
    listarPagasNoPeriodo,
    listarPendentes,
    atualizar,
    marcarComoPago,
    marcarComoPendente,
    duplicarParaProximoMes,
    excluir,
    contar,
  };
})();
