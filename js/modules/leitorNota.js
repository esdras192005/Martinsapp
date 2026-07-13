/* ======================================================================
   MARTINS — modules/leitorNota.js
   Leitor de nota fiscal / notinha por IA

   Responsabilidade deste módulo: dado uma foto (ou várias, para notas
   com mais de uma página), usar um modelo de IA com visão para
   identificar SOMENTE os itens de peça comprados — ignorando dados da
   empresa, CNPJ, endereço, impostos, forma de pagamento e qualquer
   outro texto que não seja peça — e devolver uma lista estruturada
   (descrição, marca, código, quantidade, valor unitário, valor total)
   junto do valor total geral da nota.

   Antes de mandar a foto para a IA, o módulo roda um pré-processamento
   de imagem 100% local (sem bibliotecas externas, só Canvas 2D), na
   ordem abaixo — cada etapa é isolada e "falha para o lado seguro": se
   uma etapa der problema, ela é pulada e a imagem da etapa anterior é
   usada, sem travar a leitura:
     1. Endireitar (inclinação/perspectiva): estima o ângulo de rotação
        da foto por projeção de linhas de texto e corrige.
     2. Recorte automático ao conteúdo: remove mesa/fundo ao redor da
        nota, mantendo só a área com texto/tabela impressa.
     3. Sombra, brilho e contraste: estima a iluminação de fundo (que
        pode ser desareja por sombra de mão/objeto) e a "achata", depois
        estica o histograma (auto-contraste/brilho).
     4. Nitidez: máscara de nitidez (unsharp mask) para reforçar bordas
        de texto borradas.

   Diferente dos outros módulos em js/modules/, este NÃO é uma "tela"
   registrada em App.modules — é um recurso invocado sob demanda (a
   partir do formulário de Ordens de Serviço, ver js/modules/ordens.js)
   que abre por cima de qualquer modal já aberto.

   Fluxo (todo dentro de um único modal, com "etapas"):
     1. captura   → usuário tira/escolhe 1+ fotos da nota (pré-processadas
                    automaticamente antes de virar miniatura)
     2. analisando→ chamada à IA em andamento
     3. revisao   → itens extraídos, editáveis, com validação de cálculo
                    e destaque nos campos que a própria IA relatou ter
                    baixa confiança (foto borrada, ambígua, etc.)
     4. confirmar → chama o callback (onConfirmar) com os itens revisados

   A IA NUNCA grava nada sozinha: o usuário sempre revisa e pode
   corrigir qualquer campo antes de confirmar, e mesmo depois de
   confirmado o item entra na OS com `origem: 'notinha'` e
   `confirmada: false` (ver js/db/ordens.js), então a tela da OS ainda
   destaca que aquele item segue pendente de conferência final.

   Uso público:
     LeitorNotaFiscal.abrir({
       onConfirmar(itens, meta) { ... }, // itens já no formato de pecasUtilizadas
     });
   ====================================================================== */

const LeitorNotaFiscal = (() => {

  /* --------------------------------------------------------------------
     Configuração da IA (guardada em ConfiguracoesDB, chave-valor local)
     -------------------------------------------------------------------- */
  const CHAVE_API_KEY = 'leitorNotaApiKey';
  const CHAVE_MODELO = 'leitorNotaModelo';
  const MODELO_PADRAO = 'gemini-2.5-flash';

  const LIMITE_LADO_MAIOR_PX = 2000;   // redimensiona fotos grandes antes de enviar
  const QUALIDADE_JPEG = 0.9;
  const TOLERANCIA_ABSOLUTA = 0.02;    // 2 centavos — folga de arredondamento

  // Nomes de campo aceitos em "camposBaixaConfianca" (o que vier fora
  // disso na resposta da IA é ignorado, por segurança).
  const CAMPOS_CONFIANCA_VALIDOS = ['descricao', 'marca', 'codigo', 'quantidade', 'valorUnitario', 'valorTotal'];

  // Pré-processamento de imagem (ver funções logo abaixo de prepararImagem)
  const PRE_ANGULO_MAX_GRAUS = 10;        // faixa de busca do ângulo de inclinação
  const PRE_ANGULO_PASSO_GRAUS = 0.5;
  const PRE_ANGULO_MINIMO_CORRECAO = 0.3; // abaixo disso, nem vale a pena girar
  const PRE_NITIDEZ_QUANTIDADE = 0.6;     // força da máscara de nitidez (unsharp mask)

  /** Erro específico para problemas de configuração (chave ausente/inválida). */
  class ErroConfiguracaoIA extends Error {}

  /* --------------------------------------------------------------------
     Prompt da IA — a parte mais importante da precisão deste recurso.
     Pede explicitamente para ignorar tudo que não for item de peça e
     para responder em JSON estrito, sem inventar valores incertos.
     -------------------------------------------------------------------- */
  const PROMPT_SISTEMA = `Você é um sistema especializado em ler, a partir de fotos, notas fiscais e "notinhas" (recibos) de compra de peças automotivas em uma oficina mecânica brasileira. As fotos podem estar amassadas, tortas (em perspectiva) ou com iluminação irregular (sombra de mão, reflexo, parte mais clara que outra) — leia com atenção redobrada nesses casos, usando o contexto da tabela (colunas, alinhamento, valores vizinhos) para resolver ambiguidades, e sinalize em "camposBaixaConfianca" o que mesmo assim ficar incerto.

Sua única tarefa é identificar e extrair APENAS OS ITENS DE PEÇA comprados. Ignore completamente:
- Cabeçalho da tabela de itens (ex.: a linha "COD | DESC", "VLR", "QTD", "TOTAL" — isso é rótulo de coluna, nunca um item).
- Dados da empresa emissora: razão social, nome fantasia, CNPJ, Inscrição Estadual, endereço, telefone, site.
- Dados do destinatário/cliente da nota.
- Informações fiscais: chave de acesso, número/série da nota, protocolo de autorização, tributos (ICMS, IPI, PIS, COFINS, ISS), base de cálculo, mensagens da SEFAZ.
- Forma de pagamento, parcelas, troco, dados de cartão, "Recebemos", assinatura.
- Textos legais, rodapés, propaganda, QR code, código de barras.
- Linhas de frete ou desconto que não sejam, elas mesmas, um item de peça comprado.

PASSO 1 — AGRUPAMENTO DE LINHAS ANTES DE EXTRAIR QUALQUER DADO:
Em muitas notas de balcão de autopeças, CADA ITEM OCUPA VÁRIAS LINHAS de texto, e não uma só. É comum o padrão:
  linha 1: código do produto | marca | início da descrição
  linha 2 (e às vezes 3): continuação da descrição (aplicação do veículo, medidas, referência cruzada, etc. — sem código novo no início)
  última linha do bloco: valor unitário, quantidade e valor total daquele item (colunas "VLR", "QTD", "TOTAL"), alinhados à direita, aparecendo UMA ÚNICA VEZ por item, na altura da ÚLTIMA linha da descrição daquele item — e não em cada linha do bloco.
Antes de extrair qualquer campo, primeiro percorra a nota e agrupe mentalmente todas as linhas que pertencem ao mesmo item: um novo item só começa quando aparece um NOVO código de produto (geralmente um número à esquerda, isolado, no início da linha) seguido de marca/descrição; todas as linhas seguintes que não começam com um novo código pertencem ao MESMO item anterior, até aparecer o próximo código ou os números de valor/quantidade/total daquele bloco. Nunca crie um item separado para uma linha de continuação de descrição — junte tudo em um único item, com uma única descrição (pode ter várias frases/partes) e um único conjunto de valor unitário/quantidade/total.

Exemplo de padrão (para você reconhecer a estrutura, não como texto a copiar):
  "11808 | MANN | FILTRO COMB GM/FIAT 05/FLEX - WK58"      (linha 1: código 11808, marca MANN, início da descrição)
  "17,70   1   17,70"                                       (linha 2, mesmo item: valor unitário 17,70, quantidade 1, total 17,70)
  "903 | WEGA | FILTRO AR CORSA 94/ AGILE 09/ MONT 2011/ - FAP2827"  (linha 3: NOVO código 903 → começa um novo item; note que a descrição desse item por si só já ocupa mais de uma linha impressa antes do valor aparecer)
  "15,05   1   15,05"                                       (linha 4, mesmo item do 903: valor/qtd/total)
Nesse trecho existem exatamente DOIS itens (código 11808 e código 903), não quatro — mesmo a descrição ocupando mais de uma linha impressa em cada um.

PASSO 2 — EXTRAÇÃO DE CAMPOS:
Para cada item já agrupado (bloco completo de linhas), extraia:
- "descricao": nome/descrição da peça, já reunindo todas as linhas de continuação em uma única string (limpe quebras de linha, mas não invente nem remova informação; abreviações óbvias podem ser mantidas como impressas).
- "marca": marca/fabricante da peça, se estiver identificável no início do item (geralmente entre pipes "|" logo após o código). Caso não apareça, use null.
- "codigo": código, referência ou SKU da peça, geralmente o primeiro número isolado à esquerda do bloco. Caso não apareça, use null.
- "quantidade": quantidade comprada (coluna "QTD"). Número (pode ter casas decimais, ex.: 1, 2, 0.5).
- "valorUnitario": valor unitário da peça (coluna "VLR"). Número com ponto como separador decimal, sem símbolo de moeda e sem separador de milhar (nota brasileira usa vírgula decimal — converta para ponto).
- "valorTotal": valor total daquela linha/item (coluna "TOTAL"), como impresso. Número, ou null se a nota não mostrar o total por item.
- "camposBaixaConfianca": lista com os nomes dos campos acima (dentre "descricao", "marca", "codigo", "quantidade", "valorUnitario", "valorTotal") que você não tem certeza de ter lido corretamente naquele item específico — por exemplo, por causa de borrão, dobra/amassado no papel, sombra, tinta apagada, caligrafia ou ambiguidade de agrupamento de linhas. Se você tem certeza razoável de todos os campos daquele item, use uma lista vazia [].

PASSO 3 — VALIDAÇÃO CRUZADA (faça esta conta você mesmo antes de responder):
Para cada item, confira se quantidade × valorUnitario bate com valorTotal (com folga de poucos centavos por arredondamento). Se não bater, isso é forte indício de erro de leitura em algum desses três campos — releia aquele trecho da imagem com atenção; se mesmo assim a divergência persistir, inclua o(s) campo(s) mais suspeitos em "camposBaixaConfianca" em vez de forçar os números a baterem. Da mesma forma, quando possível, some os "valorTotal" de todos os itens e confira se a soma bate com o total geral da nota — se não bater, provavelmente falta agrupar corretamente algum item (linhas separadas por engano, ou um item inteiro perdido) ou um valor foi lido errado; revise antes de responder.

Identifique também o valor total geral da nota (o total a pagar — geralmente a linha "TOTAL", "TOTAL R$", "VALOR TOTAL", "TOTAL A PAGAR" ou similar, tipicamente a última linha numérica antes de "Recebemos"/forma de pagamento), e se você tem certeza razoável dessa leitura.

Responda SOMENTE com um JSON válido, sem nenhum texto antes ou depois, sem marcação markdown (sem \`\`\`), seguindo exatamente este formato:

{
  "itens": [
    { "descricao": "string", "marca": "string ou null", "codigo": "string ou null", "quantidade": numero, "valorUnitario": numero, "valorTotal": numero ou null, "camposBaixaConfianca": ["nome_do_campo", ...] }
  ],
  "valorTotalNota": numero ou null,
  "valorTotalNotaBaixaConfianca": true ou false,
  "observacoes": "string ou null"
}

Priorize precisão acima de tudo: se um número estiver ilegível, borrado ou ambíguo, é preferível relatar isso em "camposBaixaConfianca" (ou em "observacoes", para algo mais geral) do que inventar ou "chutar" um valor — mesmo assim, sempre preencha o campo com sua melhor estimativa, apenas sinalizando a incerteza. Nunca invente peças que não estejam de fato na imagem, e nunca duplique o mesmo item em duas entradas por causa de descrição multi-linha. Se a imagem não tiver nenhum item de peça legível, devolva "itens": [].`;

  function promptUsuario(quantidadeImagens) {
    if (quantidadeImagens > 1) {
      return `Estas ${quantidadeImagens} fotos são páginas/partes da mesma nota fiscal de compra de peças, em sequência. Trate como uma única compra e devolva uma lista consolidada de itens (sem repetir item que apareça em mais de uma foto), seguindo estritamente o formato JSON combinado.`;
    }
    return 'Leia esta nota fiscal (ou notinha) de compra de peças e extraia os itens, seguindo estritamente o formato JSON combinado.';
  }

  /* --------------------------------------------------------------------
     Utilidades
     -------------------------------------------------------------------- */
  function gerarId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function arredondar(valor) {
    return Number((Math.round((Number(valor) || 0) * 100) / 100).toFixed(2));
  }

  function calcularSubtotal(item) {
    return arredondar((Number(item.quantidade) || 0) * (Number(item.valorUnitario) || 0));
  }

  // Rótulos legíveis para exibir quais campos a IA relatou baixa confiança.
  const RESULTADO_LABEL_CAMPO = {
    descricao: 'descrição',
    marca: 'marca',
    codigo: 'código',
    quantidade: 'quantidade',
    valorUnitario: 'valor unitário',
    valorTotal: 'valor total da linha',
  };

  function listarCamposIncertos(campos) {
    return (campos || []).map((campo) => RESULTADO_LABEL_CAMPO[campo] || campo).join(', ');
  }

  /* --------------------------------------------------------------------
     Preparo da imagem: redimensiona para não estourar tamanho de
     requisição/custo de IA, mantendo resolução alta o bastante para OCR.
     -------------------------------------------------------------------- */
  async function carregarComoImagem(arquivo) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(arquivo);
      } catch (e) {
        // cai para o fallback abaixo
      }
    }
    const url = URL.createObjectURL(arquivo);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function prepararImagem(arquivo) {
    const imagem = await carregarComoImagem(arquivo);
    const largura = imagem.width || imagem.naturalWidth;
    const altura = imagem.height || imagem.naturalHeight;
    const escala = Math.min(1, LIMITE_LADO_MAIOR_PX / Math.max(largura, altura));
    const larguraFinal = Math.max(1, Math.round(largura * escala));
    const alturaFinal = Math.max(1, Math.round(altura * escala));

    const canvas = document.createElement('canvas');
    canvas.width = larguraFinal;
    canvas.height = alturaFinal;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imagem, 0, 0, larguraFinal, alturaFinal);

    // Pré-processamento local (perspectiva/inclinação, sombra, brilho,
    // contraste, nitidez) para ajudar a IA a ler melhor. Cada etapa
    // protege a anterior: se algo der errado, a imagem some sem o ajuste
    // daquela etapa em vez de travar a captura da foto.
    let canvasProcessado = canvas;
    try {
      canvasProcessado = melhorarImagemParaOCR(canvas);
    } catch (erro) {
      console.warn('Pré-processamento da imagem falhou por completo; usando a foto apenas redimensionada.', erro);
      canvasProcessado = canvas;
    }

    const dataUrl = canvasProcessado.toDataURL('image/jpeg', QUALIDADE_JPEG);
    return {
      id: gerarId(),
      base64: dataUrl.split(',')[1],
      mediaType: 'image/jpeg',
      previewUrl: dataUrl,
    };
  }

  /* --------------------------------------------------------------------
     Pré-processamento de imagem para OCR (100% local, só Canvas 2D).

     Cada função abaixo recebe um canvas e devolve um canvas (o mesmo ou
     um novo) — nunca lança para fora sem necessidade: problemas são
     capturados e a função devolve a imagem de entrada sem alteração,
     para que uma etapa ruim nunca destrua o resultado das anteriores.
     -------------------------------------------------------------------- */

  /** Desfoque de caixa (box blur) separável, O(n) por pixel independente do raio — usado tanto para estimar sombra/fundo quanto para nitidez. */
  function desfoqueCaixaSeparavel(entrada, largura, altura, raio) {
    if (raio < 1) return Float32Array.from(entrada);
    const tamanhoJanela = raio * 2 + 1;
    const horizontal = new Float32Array(entrada.length);

    for (let y = 0; y < altura; y++) {
      const linhaBase = y * largura;
      let soma = 0;
      for (let x = -raio; x <= raio; x++) {
        const xClamp = Math.min(largura - 1, Math.max(0, x));
        soma += entrada[linhaBase + xClamp];
      }
      for (let x = 0; x < largura; x++) {
        horizontal[linhaBase + x] = soma / tamanhoJanela;
        const xSai = Math.min(largura - 1, Math.max(0, x - raio));
        const xEntra = Math.min(largura - 1, Math.max(0, x + raio + 1));
        soma += entrada[linhaBase + xEntra] - entrada[linhaBase + xSai];
      }
    }

    const final = new Float32Array(entrada.length);
    for (let x = 0; x < largura; x++) {
      let soma = 0;
      for (let y = -raio; y <= raio; y++) {
        const yClamp = Math.min(altura - 1, Math.max(0, y));
        soma += horizontal[yClamp * largura + x];
      }
      for (let y = 0; y < altura; y++) {
        final[y * largura + x] = soma / tamanhoJanela;
        const ySai = Math.min(altura - 1, Math.max(0, y - raio));
        const yEntra = Math.min(altura - 1, Math.max(0, y + raio + 1));
        soma += horizontal[yEntra * largura + x] - horizontal[ySai * largura + x];
      }
    }
    return final;
  }

  /** Estima o ângulo de inclinação (graus) de um canvas por projeção de linhas de texto: testa vários ângulos e escolhe o que deixa as linhas de texto mais "bem definidas" (maior variância na soma de pixels escuros por linha). */
  function estimarAnguloInclinacao(canvasOrigem) {
    const larguraAmostra = Math.min(300, canvasOrigem.width);
    const escala = larguraAmostra / canvasOrigem.width;
    const alturaAmostra = Math.max(1, Math.round(canvasOrigem.height * escala));

    const amostra = document.createElement('canvas');
    amostra.width = larguraAmostra;
    amostra.height = alturaAmostra;
    const ctxAmostra = amostra.getContext('2d');
    ctxAmostra.drawImage(canvasOrigem, 0, 0, larguraAmostra, alturaAmostra);

    const dados = ctxAmostra.getImageData(0, 0, larguraAmostra, alturaAmostra).data;
    const luminancia = new Float32Array(larguraAmostra * alturaAmostra);
    let somaLuminancia = 0;
    for (let i = 0, p = 0; i < dados.length; i += 4, p++) {
      const l = 0.299 * dados[i] + 0.587 * dados[i + 1] + 0.114 * dados[i + 2];
      luminancia[p] = l;
      somaLuminancia += l;
    }
    const media = somaLuminancia / luminancia.length;

    // "1" marca pixel de tinta/texto (bem mais escuro que a média da amostra).
    const binaria = new Uint8Array(luminancia.length);
    for (let p = 0; p < luminancia.length; p++) {
      binaria[p] = luminancia[p] < media * 0.85 ? 1 : 0;
    }

    function pontuarAngulo(anguloGraus) {
      const rad = (anguloGraus * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const somaPorLinha = new Float64Array(alturaAmostra);

      for (let y = 0; y < alturaAmostra; y++) {
        for (let x = 0; x < larguraAmostra; x++) {
          if (!binaria[y * larguraAmostra + x]) continue;
          const yRotacionado = Math.round(-x * sin + y * cos);
          if (yRotacionado >= 0 && yRotacionado < alturaAmostra) {
            somaPorLinha[yRotacionado]++;
          }
        }
      }

      let media2 = 0;
      for (let i = 0; i < somaPorLinha.length; i++) media2 += somaPorLinha[i];
      media2 /= somaPorLinha.length;
      let variancia = 0;
      for (let i = 0; i < somaPorLinha.length; i++) {
        const d = somaPorLinha[i] - media2;
        variancia += d * d;
      }
      return variancia;
    }

    let melhorAngulo = 0;
    let melhorPontuacao = -Infinity;
    for (let angulo = -PRE_ANGULO_MAX_GRAUS; angulo <= PRE_ANGULO_MAX_GRAUS; angulo += PRE_ANGULO_PASSO_GRAUS) {
      const pontuacao = pontuarAngulo(angulo);
      if (pontuacao > melhorPontuacao) {
        melhorPontuacao = pontuacao;
        melhorAngulo = angulo;
      }
    }

    // Refinamento fino ao redor do melhor ângulo encontrado.
    let mel
