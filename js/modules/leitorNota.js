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
    let melhorAnguloFino = melhorAngulo;
    let melhorPontuacaoFina = melhorPontuacao;
    for (let angulo = melhorAngulo - PRE_ANGULO_PASSO_GRAUS; angulo <= melhorAngulo + PRE_ANGULO_PASSO_GRAUS; angulo += 0.1) {
      const pontuacao = pontuarAngulo(angulo);
      if (pontuacao > melhorPontuacaoFina) {
        melhorPontuacaoFina = pontuacao;
        melhorAnguloFino = angulo;
      }
    }

    return melhorAnguloFino;
  }

  /** Gira um canvas por um ângulo (graus), expandindo a tela para não cortar nada. Fundo branco (não transparente) para não confundir a IA com bordas pretas. */
  function girarCanvas(canvasOrigem, anguloGraus) {
    const rad = (anguloGraus * Math.PI) / 180;
    const { width: w, height: h } = canvasOrigem;
    const novaLargura = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
    const novaAltura = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));

    const destino = document.createElement('canvas');
    destino.width = novaLargura;
    destino.height = novaAltura;
    const ctx = destino.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, novaLargura, novaAltura);
    ctx.translate(novaLargura / 2, novaAltura / 2);
    ctx.rotate(rad);
    ctx.drawImage(canvasOrigem, -w / 2, -h / 2);
    return destino;
  }

  /**
   * Corrige a inclinação/perspectiva de rotação da foto. Em vez de confiar
   * cegamente no sinal do ângulo detectado (é fácil trocar o sentido da
   * rotação por engano), testa girar para os dois lados e mede de novo o
   * ângulo residual em cada resultado — mantém o que ficou mais reto, e
   * desiste (mantendo a foto original) se nenhum dos dois ajudou.
   */
  function endireitarCanvas(canvasOrigem) {
    try {
      const anguloDetectado = estimarAnguloInclinacao(canvasOrigem);
      if (Math.abs(anguloDetectado) < PRE_ANGULO_MINIMO_CORRECAO) return canvasOrigem;

      const candidatoA = girarCanvas(canvasOrigem, anguloDetectado);
      const candidatoB = girarCanvas(canvasOrigem, -anguloDetectado);
      const residuoA = Math.abs(estimarAnguloInclinacao(candidatoA));
      const residuoB = Math.abs(estimarAnguloInclinacao(candidatoB));
      const residuoOriginal = Math.abs(anguloDetectado);

      if (residuoA <= residuoB && residuoA < residuoOriginal) return candidatoA;
      if (residuoB < residuoA && residuoB < residuoOriginal) return candidatoB;
      return canvasOrigem;
    } catch (erro) {
      console.warn('Correção de inclinação/perspectiva falhou, mantendo a foto original:', erro);
      return canvasOrigem;
    }
  }

  /** Recorta a foto à área com conteúdo impresso (texto/tabela), removendo mesa/fundo ao redor da nota. Protegido contra recortes degenerados (mantém a foto original se o recorte encontrado parecer errado). */
  function recortarAoConteudo(canvasOrigem) {
    try {
      const { width, height } = canvasOrigem;
      const ctx = canvasOrigem.getContext('2d');
      const dados = ctx.getImageData(0, 0, width, height).data;

      const luminancia = new Float32Array(width * height);
      let somaLuminancia = 0;
      for (let i = 0, p = 0; i < dados.length; i += 4, p++) {
        const l = 0.299 * dados[i] + 0.587 * dados[i + 1] + 0.114 * dados[i + 2];
        luminancia[p] = l;
        somaLuminancia += l;
      }
      const mediaGeral = somaLuminancia / luminancia.length;
      const limiar = mediaGeral * 0.82;

      const somaPorLinha = new Uint32Array(height);
      const somaPorColuna = new Uint32Array(width);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (luminancia[y * width + x] < limiar) {
            somaPorLinha[y]++;
            somaPorColuna[x]++;
          }
        }
      }

      const minimoPorLinha = Math.max(2, width * 0.004);
      const minimoPorColuna = Math.max(2, height * 0.004);

      let topo = 0;
      while (topo < height && somaPorLinha[topo] < minimoPorLinha) topo++;
      let base = height - 1;
      while (base > topo && somaPorLinha[base] < minimoPorLinha) base--;
      let esquerda = 0;
      while (esquerda < width && somaPorColuna[esquerda] < minimoPorColuna) esquerda++;
      let direita = width - 1;
      while (direita > esquerda && somaPorColuna[direita] < minimoPorColuna) direita--;

      const margem = Math.round(Math.min(width, height) * 0.02);
      topo = Math.max(0, topo - margem);
      base = Math.min(height - 1, base + margem);
      esquerda = Math.max(0, esquerda - margem);
      direita = Math.min(width - 1, direita + margem);

      const novaLargura = direita - esquerda;
      const novaAltura = base - topo;
      const areaOriginal = width * height;
      const areaRecorte = novaLargura * novaAltura;

      // Recorte degenerado (praticamente a foto inteira, ou pequeno demais
      // para ser a nota) — mais seguro manter a foto como está.
      if (novaLargura < width * 0.3 || novaAltura < height * 0.3) return canvasOrigem;
      if (areaRecorte > areaOriginal * 0.97) return canvasOrigem;

      const destino = document.createElement('canvas');
      destino.width = novaLargura;
      destino.height = novaAltura;
      destino.getContext('2d').drawImage(canvasOrigem, esquerda, topo, novaLargura, novaAltura, 0, 0, novaLargura, novaAltura);
      return destino;
    } catch (erro) {
      console.warn('Recorte automático ao conteúdo falhou, mantendo a foto original:', erro);
      return canvasOrigem;
    }
  }

  /** Achata sombras/iluminação despareja (dividindo pela estimativa de fundo desfocado) e aplica auto-contraste/brilho esticando o histograma pelos percentis 1%–99%. Atua no próprio canvas recebido (mutação) e o devolve. */
  function corrigirIluminacaoEContraste(canvasOrigem) {
    try {
      const { width, height } = canvasOrigem;
      const ctx = canvasOrigem.getContext('2d');
      const imageData = ctx.getImageData(0, 0, width, height);
      const dados = imageData.data;
      const totalPixels = width * height;

      const luminancia = new Float32Array(totalPixels);
      for (let i = 0, p = 0; i < dados.length; i += 4, p++) {
        luminancia[p] = 0.299 * dados[i] + 0.587 * dados[i + 1] + 0.114 * dados[i + 2];
      }

      // 1) Estimativa de fundo (papel + sombra) via desfoque bem largo —
      // dividir a imagem por isso "achata" sombras e gradientes de luz.
      const raioFundo = Math.max(8, Math.round(Math.min(width, height) / 12));
      const fundo = desfoqueCaixaSeparavel(luminancia, width, height, raioFundo);

      const razaoSombra = new Float32Array(totalPixels);
      const luminanciaCorrigida = new Float32Array(totalPixels);
      for (let p = 0; p < totalPixels; p++) {
        const razao = 235 / Math.max(fundo[p], 15);
        razaoSombra[p] = razao;
        luminanciaCorrigida[p] = luminancia[p] * razao;
      }

      // 2) Auto-contraste: percentis 1%/99% (amostrados, não a imagem
      // inteira, para não pesar demais) como ponto preto/branco.
      const passoAmostra = Math.max(1, Math.floor(totalPixels / 50000));
      const amostra = [];
      for (let p = 0; p < totalPixels; p += passoAmostra) amostra.push(luminanciaCorrigida[p]);
      amostra.sort((a, b) => a - b);
      const p1 = amostra[Math.floor(amostra.length * 0.01)] ?? 0;
      const p99 = amostra[Math.floor(amostra.length * 0.99)] ?? 255;
      const escalaContraste = 255 / Math.max(1, p99 - p1);

      for (let i = 0, p = 0; i < dados.length; i += 4, p++) {
        const razao = razaoSombra[p];
        for (let canal = 0; canal < 3; canal++) {
          let valor = dados[i + canal] * razao;
          valor = (valor - p1) * escalaContraste;
          dados[i + canal] = Math.max(0, Math.min(255, valor));
        }
      }

      ctx.putImageData(imageData, 0, 0);
      return canvasOrigem;
    } catch (erro) {
      console.warn('Correção de sombra/brilho/contraste falhou, mantendo a foto como estava:', erro);
      return canvasOrigem;
    }
  }

  /** Máscara de nitidez (unsharp mask): reforça bordas comparando cada canal com uma versão levemente desfocada dele mesmo. */
  function aplicarNitidez(canvasOrigem, quantidade = PRE_NITIDEZ_QUANTIDADE) {
    try {
      const { width, height } = canvasOrigem;
      const ctx = canvasOrigem.getContext('2d');
      const imageData = ctx.getImageData(0, 0, width, height);
      const dados = imageData.data;
      const raio = 1;

      for (let canal = 0; canal < 3; canal++) {
        const canalDados = new Float32Array(width * height);
        for (let i = 0, p = 0; i < dados.length; i += 4, p++) {
          canalDados[p] = dados[i + canal];
        }
        const desfocado = desfoqueCaixaSeparavel(canalDados, width, height, raio);
        for (let i = 0, p = 0; i < dados.length; i += 4, p++) {
          const valorNitido = canalDados[p] + quantidade * (canalDados[p] - desfocado[p]);
          dados[i + canal] = Math.max(0, Math.min(255, valorNitido));
        }
      }

      ctx.putImageData(imageData, 0, 0);
      return canvasOrigem;
    } catch (erro) {
      console.warn('Nitidez automática falhou, mantendo a foto como estava:', erro);
      return canvasOrigem;
    }
  }

  /** Orquestra o pré-processamento completo, na ordem que dá melhor resultado prático: primeiro endireita e recorta (que dependem da geometria original), só depois mexe em brilho/sombra/nitidez (que dependem só de pixels). */
  function melhorarImagemParaOCR(canvasOriginal) {
    let canvas = canvasOriginal;
    canvas = endireitarCanvas(canvas);
    canvas = recortarAoConteudo(canvas);
    canvas = corrigirIluminacaoEContraste(canvas);
    canvas = aplicarNitidez(canvas);
    return canvas;
  }

  /* --------------------------------------------------------------------
     Chamada à IA (Gemini API — Google), direto do dispositivo.
     A chave fica salva só localmente (IndexedDB) e nunca é enviada a
     lugar nenhum além do próprio Google. Usa o tier gratuito da API do
     Gemini (sem cartão de crédito, com limite diário de requisições).
     -------------------------------------------------------------------- */
  async function chamarIA(imagens) {
    const apiKey = await ConfiguracoesDB.obter(CHAVE_API_KEY);
    const modelo = await ConfiguracoesDB.obter(CHAVE_MODELO, MODELO_PADRAO);

    if (!apiKey) {
      throw new ErroConfiguracaoIA('Configure a chave da API de IA antes de ler uma nota fiscal.');
    }

    const blocosImagem = imagens.map((img) => ({
      inlineData: { mimeType: img.mediaType, data: img.base64 },
    }));

    const corpo = {
      systemInstruction: { parts: [{ text: PROMPT_SISTEMA }] },
      contents: [
        {
          role: 'user',
          parts: [...blocosImagem, { text: promptUsuario(imagens.length) }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const modeloFinal = modelo || MODELO_PADRAO;
    let resposta;
    try {
      resposta = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modeloFinal}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(corpo),
        }
      );
    } catch (erroRede) {
      throw new Error('Não foi possível conectar ao serviço de IA. Verifique sua conexão com a internet e tente novamente.');
    }

    if (!resposta.ok) {
      if (resposta.status === 400 || resposta.status === 403) {
        throw new ErroConfiguracaoIA('Chave da API inválida, expirada ou sem permissão. Verifique a configuração.');
      }
      if (resposta.status === 429) {
        throw new Error('Limite gratuito de requisições do serviço de IA atingido por hoje. Aguarde e tente novamente mais tarde.');
      }
      const textoErro = await resposta.text().catch(() => '');
      throw new Error(`O serviço de IA recusou a requisição (HTTP ${resposta.status}). ${textoErro.slice(0, 220)}`);
    }

    const dados = await resposta.json();
    const candidato = (dados.candidates || [])[0];

    if (!candidato) {
      throw new Error('O serviço de IA não devolveu nenhuma resposta. Tente novamente com a foto mais nítida.');
    }
    if (candidato.finishReason === 'SAFETY') {
      throw new Error('O serviço de IA recusou analisar essa imagem. Tente outra foto da nota.');
    }
    if (candidato.finishReason === 'MAX_TOKENS') {
      throw new Error('A resposta da IA foi cortada por limite de tamanho. Tente novamente (ou com menos itens/páginas por vez).');
    }

    const textoResposta = ((candidato.content || {}).parts || [])
      .filter((bloco) => typeof bloco.text === 'string')
      .map((bloco) => bloco.text)
      .join('\n')
      .trim();

    return interpretarRespostaIA(textoResposta);
  }

  /** Faz o parse defensivo do JSON devolvido pela IA. */
  function interpretarRespostaIA(texto) {
    const limpo = texto
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let json;
    try {
      json = JSON.parse(limpo);
    } catch (erroInicial) {
      // Rede de segurança: se sobrou algum texto antes/depois do JSON
      // (a IA não deveria, mas pode acontecer), tenta isolar só o trecho
      // entre a primeira "{" e a última "}" antes de desistir de vez.
      const inicio = limpo.indexOf('{');
      const fim = limpo.lastIndexOf('}');
      if (inicio !== -1 && fim > inicio) {
        try {
          json = JSON.parse(limpo.slice(inicio, fim + 1));
        } catch (erroFallback) {
          throw new Error('A IA não devolveu um resultado no formato esperado. Tente novamente com a foto mais nítida, bem enquadrada e com boa luz.');
        }
      } else {
        throw new Error('A IA não devolveu um resultado no formato esperado. Tente novamente com a foto mais nítida, bem enquadrada e com boa luz.');
      }
    }

    const itensBrutos = Array.isArray(json.itens) ? json.itens : [];

    const itens = itensBrutos.map((item) => {
      const quantidade = Number(item.quantidade);
      const valorUnitario = Number(item.valorUnitario);
      const valorTotalLidoBruto = item.valorTotal;
      const camposBaixaConfianca = Array.isArray(item.camposBaixaConfianca)
        ? item.camposBaixaConfianca
            .map((campo) => (campo || '').toString().trim())
            .filter((campo) => CAMPOS_CONFIANCA_VALIDOS.includes(campo))
        : [];
      const itemLido = {
        id: gerarId(),
        descricao: (item.descricao || '').toString().trim() || 'Peça não identificada',
        marca: (item.marca || '').toString().trim() || '',
        codigo: (item.codigo || '').toString().trim() || '',
        quantidade: Number.isFinite(quantidade) && quantidade > 0 ? quantidade : 1,
        valorUnitario: Number.isFinite(valorUnitario) && valorUnitario >= 0 ? valorUnitario : 0,
        valorTotalLido: valorTotalLidoBruto != null && !isNaN(Number(valorTotalLidoBruto))
          ? Number(valorTotalLidoBruto)
          : null,
        camposBaixaConfianca,
      };

      // Correção automática por dicionário: compara a descrição/marca
      // lidas com uma lista interna de peças e marcas conhecidas do
      // mercado e ajusta pequenos erros de leitura (ex.: "Boch" ->
      // "Bosch"). Se o dicionário não estiver disponível por algum
      // motivo, ou nada parecido o suficiente for encontrado, o item
      // segue exatamente como a IA leu — nada mais no fluxo muda.
      let itemFinal = itemLido;
      if (typeof DicionarioPecas !== 'undefined') {
        try {
          itemFinal = DicionarioPecas.corrigirItem(itemLido).item;
        } catch (erroDicionario) {
          // Falha no dicionário nunca deve travar a leitura da nota.
          itemFinal = itemLido;
        }
      }

      // Validação automática do cálculo da linha: se a própria IA não
      // sinalizou dúvida, mas quantidade × valorUnitario não bate com o
      // valorTotal impresso (fora da tolerância de arredondamento), o
      // item claramente precisa de conferência — destacamos "valorTotal"
      // como baixa confiança mesmo sem a IA ter dito isso, em vez de
      // deixar passar batido.
      if (itemFinal.valorTotalLido != null) {
        const subtotalCalculado = calcularSubtotal(itemFinal);
        const divergencia = Math.abs(subtotalCalculado - itemFinal.valorTotalLido);
        if (divergencia > TOLERANCIA_ABSOLUTA && !itemFinal.camposBaixaConfianca.includes('valorTotal')) {
          itemFinal.camposBaixaConfianca = [...itemFinal.camposBaixaConfianca, 'valorTotal'];
        }
      }

      return itemFinal;
    });

    const valorTotalNota = json.valorTotalNota != null && !isNaN(Number(json.valorTotalNota))
      ? Number(json.valorTotalNota)
      : null;

    // Validação automática do total geral: se a soma dos itens não bate
    // com o total impresso da nota (fora de uma tolerância de 1% / 2
    // centavos), destacamos o campo do total para revisão mesmo que a
    // IA tenha relatado certeza — normalmente indica item faltando,
    // duplicado, ou mal agrupado entre linhas.
    const somaItens = arredondar(itens.reduce((soma, item) => soma + calcularSubtotal(item), 0));
    let valorTotalNotaBaixaConfianca = Boolean(json.valorTotalNotaBaixaConfianca);
    if (valorTotalNota != null && itens.length) {
      const tolerancia = Math.max(TOLERANCIA_ABSOLUTA, Math.abs(valorTotalNota) * 0.01);
      if (Math.abs(somaItens - valorTotalNota) > tolerancia) {
        valorTotalNotaBaixaConfianca = true;
      }
    }

    return {
      itens,
      valorTotalNota,
      valorTotalNotaBaixaConfianca,
      observacoes: (json.observacoes || '').toString().trim() || null,
    };
  }

  /* --------------------------------------------------------------------
     Estado do módulo (um "fluxo" de leitura por vez)
     -------------------------------------------------------------------- */
  const state = {
    etapa: null,          // 'config' | 'captura' | 'analisando' | 'revisao' | 'erro'
    imagens: [],          // [{ id, base64, mediaType, previewUrl }]
    processandoImagem: false, // true enquanto uma foto recém-capturada está sendo pré-processada
    itens: [],            // itens em revisão (editáveis)
    valorTotalNota: null, // total lido da nota, editável na revisão
    valorTotalNotaBaixaConfianca: false, // true se a própria IA relatou incerteza nessa leitura
    observacoesIA: null,
    mensagemErro: '',
    etapaAoErrar: 'captura',
    onConfirmar: null,
  };

  const els = {};

  // Utilitários compartilhados (ver js/core/utils.js).
  const { formatarMoeda, escapeHtml, mostrarToast } = Utils;

  /* --------------------------------------------------------------------
     Modal próprio (overlay separado do modal de Ordens, para poder
     abrir por cima dele sem fechar o formulário em andamento).
     -------------------------------------------------------------------- */
  // Este modal é montado à mão (em vez de usar Utils.criarModal, como os
  // demais módulos) de propósito: aqui não fechamos ao tocar fora nem com
  // Esc, para não perder fotos/itens já capturados por engano no meio do
  // fluxo de leitura — o fechamento só acontece pelo "x" ou pelos botões
  // de ação (Cancelar/Confirmar) explícitos de cada etapa.
  function montarModalSeNecessario() {
    if (els.overlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay leitor-overlay';
    overlay.id = 'leitor-nota-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="leitor-nota-titulo">
        <div class="modal-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <h2 class="modal-titulo" id="leitor-nota-titulo">Leitor de nota fiscal</h2>
          <button type="button" class="modal-fechar" id="leitor-nota-fechar" aria-label="Fechar">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <div class="modal-body" id="leitor-nota-corpo"></div>
        <div class="modal-footer" id="leitor-nota-rodape"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#leitor-nota-fechar').addEventListener('click', fechar);

    els.overlay = overlay;
    els.corpo = overlay.querySelector('#leitor-nota-corpo');
    els.rodape = overlay.querySelector('#leitor-nota-rodape');
  }

  function abrirOverlay() {
    els.overlay.classList.add('is-open');
    document.body.classList.add('modal-aberto');
  }

  function fechar() {
    els.overlay.classList.remove('is-open');
    els.corpo.innerHTML = '';
    els.rodape.innerHTML = '';
    state.etapa = null;
    state.imagens = [];
    state.processandoImagem = false;
    state.itens = [];
    state.valorTotalNota = null;
    state.valorTotalNotaBaixaConfianca = false;
    state.observacoesIA = null;
    state.onConfirmar = null;
    // Só tira o "modal-aberto" do body se não houver outro modal (o de
    // Ordens, por exemplo) ainda aberto por baixo deste.
    const outroModalAberto = document.querySelector('.modal-overlay.is-open');
    if (!outroModalAberto) {
      document.body.classList.remove('modal-aberto');
    }
  }

  /* --------------------------------------------------------------------
     Etapa: configuração da chave de IA (só aparece se ainda não houver
     uma chave salva neste aparelho)
     -------------------------------------------------------------------- */
  function renderConfig() {
    els.corpo.innerHTML = `
      <div class="leitor-config">
        <p class="leitor-texto">
          Para ler notas fiscais automaticamente, o app usa a IA do Google
          (Gemini). Informe a chave de API uma única vez — ela fica salva só
          neste aparelho e é usada apenas para consultar o serviço de IA.
        </p>
        <div class="form-group">
          <label for="leitor-config-chave">Chave da API (Gemini)</label>
          <input type="password" id="leitor-config-chave" placeholder="AIza..." autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <p class="leitor-dica">Não tem uma chave? Gere uma de graça em aistudio.google.com (menu "Get API key").</p>
        <p class="form-erro" id="leitor-config-erro" hidden></p>
      </div>
    `;

    els.rodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="leitor-config-cancelar">Cancelar</button>
      <button type="button" class="btn btn-primary" id="leitor-config-salvar">Salvar e continuar</button>
    `;

    document.getElementById('leitor-config-cancelar').addEventListener('click', fechar);
    document.getElementById('leitor-config-salvar').addEventListener('click', async () => {
      const campo = document.getElementById('leitor-config-chave');
      const erroEl = document.getElementById('leitor-config-erro');
      const chave = campo.value.trim();
      if (!chave) {
        erroEl.textContent = 'Informe a chave da API.';
        erroEl.hidden = false;
        return;
      }
      await ConfiguracoesDB.definir(CHAVE_API_KEY, chave);
      mostrarToast('Chave da IA salva neste aparelho.');
      irParaCaptura();
    });

    abrirOverlay();
  }

  /* --------------------------------------------------------------------
     Etapa: captura de foto(s)
     -------------------------------------------------------------------- */
  function renderCaptura() {
    const thumbsHtml = state.imagens.map((img, indice) => `
      <div class="leitor-thumb" data-id="${img.id}">
        <img src="${img.previewUrl}" alt="Página ${indice + 1} da nota">
        <span class="leitor-thumb-numero">${indice + 1}</span>
        <span class="leitor-thumb-otimizada" title="Perspectiva, brilho, sombra, contraste e nitidez ajustados automaticamente">✨</span>
        <button type="button" class="leitor-thumb-remover" data-id="${img.id}" aria-label="Remover esta foto">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
        </button>
      </div>
    `).join('');

    const thumbProcessandoHtml = state.processandoImagem ? `
      <div class="leitor-thumb leitor-thumb-processando" aria-label="Otimizando imagem">
        <div class="leitor-spinner leitor-spinner-mini" aria-hidden="true"></div>
      </div>
    ` : '';

    els.corpo.innerHTML = `
      <div class="leitor-captura">
        <p class="leitor-texto">
          Tire uma foto ou escolha uma imagem da nota fiscal (ou notinha) da peça.
          Se a nota tiver mais de uma página, adicione todas antes de analisar.
          Perspectiva, brilho, sombra e nitidez são corrigidos automaticamente antes da leitura.
        </p>
        <div class="leitor-thumbs" id="leitor-thumbs">
          ${thumbsHtml}
          ${thumbProcessandoHtml}
          <button type="button" class="leitor-thumb-add" id="leitor-add-foto" aria-label="Adicionar foto" ${state.processandoImagem ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-1.6A1 1 0 0 1 9.35 5h5.3a1 1 0 0 1 .85.4L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z" stroke-linejoin="round"/>
              <circle cx="12" cy="13" r="3.2"/>
            </svg>
            <span>${state.processandoImagem ? 'Otimizando...' : (state.imagens.length ? 'Adicionar página' : 'Adicionar foto')}</span>
          </button>
        </div>
        <input type="file" id="leitor-input-arquivo" accept="image/*" hidden>
      </div>
    `;

    els.rodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="leitor-captura-cancelar">Cancelar</button>
      <button type="button" class="btn btn-primary" id="leitor-captura-analisar" ${state.imagens.length && !state.processandoImagem ? '' : 'disabled'}>Analisar nota</button>
    `;

    const inputArquivo = document.getElementById('leitor-input-arquivo');

    document.getElementById('leitor-add-foto').addEventListener('click', () => inputArquivo.click());

    inputArquivo.addEventListener('change', async () => {
      const arquivo = inputArquivo.files[0];
      inputArquivo.value = '';
      if (!arquivo) return;

      state.processandoImagem = true;
      renderCaptura();

      try {
        const imagemPreparada = await prepararImagem(arquivo);
        state.imagens.push(imagemPreparada);
      } catch (erro) {
        mostrarToast('Não foi possível carregar essa imagem. Tente outra foto.', 'erro');
      } finally {
        state.processandoImagem = false;
        renderCaptura();
      }
    });

    document.getElementById('leitor-thumbs').addEventListener('click', (e) => {
      const botaoRemover = e.target.closest('.leitor-thumb-remover');
      if (!botaoRemover) return;
      state.imagens = state.imagens.filter((img) => img.id !== botaoRemover.dataset.id);
      renderCaptura();
    });

    document.getElementById('leitor-captura-cancelar').addEventListener('click', fechar);
    document.getElementById('leitor-captura-analisar').addEventListener('click', analisar);

    abrirOverlay();
  }

  function irParaCaptura() {
    state.etapa = 'captura';
    renderCaptura();
  }

  /* --------------------------------------------------------------------
     Etapa: analisando (chamada à IA em andamento)
     -------------------------------------------------------------------- */
  function renderAnalisando() {
    els.corpo.innerHTML = `
      <div class="leitor-carregando">
        <div class="leitor-spinner" aria-hidden="true"></div>
        <p class="leitor-texto">Lendo a nota fiscal com IA…</p>
        <p class="leitor-dica">Isso pode levar alguns segundos, dependendo da conexão.</p>
      </div>
    `;
    els.rodape.innerHTML = '';
  }

  async function analisar() {
    state.etapa = 'analisando';
    renderAnalisando();

    try {
      const resultado = await chamarIA(state.imagens);
      state.itens = resultado.itens;
      state.valorTotalNota = resultado.valorTotalNota;
      state.valorTotalNotaBaixaConfianca = resultado.valorTotalNotaBaixaConfianca;
      state.observacoesIA = resultado.observacoes;

      if (!state.itens.length) {
        mostrarToast('Nenhum item de peça foi identificado nessa foto. Você pode tentar novamente ou adicionar peças manualmente.', 'erro');
      }

      state.etapa = 'revisao';
      renderRevisao();
    } catch (erro) {
      if (erro instanceof ErroConfiguracaoIA) {
        mostrarToast(erro.message, 'erro');
        state.etapa = 'config';
        renderConfig();
        return;
      }
      state.mensagemErro = erro.message || 'Não foi possível analisar a nota fiscal.';
      state.etapaAoErrar = 'captura';
      state.etapa = 'erro';
      renderErro();
    }
  }

  /* --------------------------------------------------------------------
     Etapa: erro genérico, com opção de tentar de novo
     -------------------------------------------------------------------- */
  function renderErro() {
    els.corpo.innerHTML = `
      <div class="leitor-erro">
        <p class="form-erro">${escapeHtml(state.mensagemErro)}</p>
      </div>
    `;
    els.rodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="leitor-erro-cancelar">Cancelar</button>
      <button type="button" class="btn btn-primary" id="leitor-erro-tentar">Tentar novamente</button>
    `;
    document.getElementById('leitor-erro-cancelar').addEventListener('click', fechar);
    document.getElementById('leitor-erro-tentar').addEventListener('click', () => {
      if (state.etapaAoErrar === 'captura') {
        irParaCaptura();
      } else {
        analisar();
      }
    });
  }

  /* --------------------------------------------------------------------
     Etapa: revisão dos itens extraídos (editável) + validação de cálculo
     -------------------------------------------------------------------- */

  /** Recalcula e redesenha só o banner de totais (sem re-renderizar a lista, para não perder o foco do campo em edição). */
  function atualizarBannerTotal() {
    const somaCalculada = arredondar(state.itens.reduce((soma, item) => soma + calcularSubtotal(item), 0));
    const banner = document.getElementById('leitor-banner-total');
    if (!banner) return;

    const totalNota = state.valorTotalNota;
    const diferenca = totalNota != null ? arredondar(somaCalculada - totalNota) : null;
    const tolerancia = totalNota != null ? Math.max(TOLERANCIA_ABSOLUTA, Math.abs(totalNota) * 0.01) : null;
    const bate = totalNota == null || Math.abs(diferenca) <= tolerancia;

    banner.classList.toggle('leitor-banner-alerta', !bate);
    banner.classList.toggle('leitor-banner-ok', bate && totalNota != null);

    const textoComparacao = document.getElementById('leitor-banner-comparacao');
    if (textoComparacao) {
      if (totalNota == null) {
        textoComparacao.textContent = 'Informe o valor total impresso na nota para conferir automaticamente.';
      } else if (bate) {
        textoComparacao.textContent = '✓ A soma dos itens bate com o total da nota.';
      } else {
        const sinal = diferenca > 0 ? 'a mais' : 'a menos';
        textoComparacao.textContent = `⚠ A soma dos itens está ${formatarMoeda(Math.abs(diferenca))} ${sinal} em relação ao total da nota. Confira se falta algum item, ou se há frete/desconto não listado como peça.`;
      }
    }

    const somaEl = document.getElementById('leitor-banner-soma');
    if (somaEl) somaEl.textContent = formatarMoeda(somaCalculada);
  }

  /** Recalcula e redesenha só a linha (subtotal + selo de alerta) de um item específico. */
  function atualizarLinhaItem(id) {
    const item = state.itens.find((i) => i.id === id);
    const linha = document.querySelector(`.leitor-item[data-id="${id}"]`);
    if (!item || !linha) return;

    const subtotal = calcularSubtotal(item);
    const temValorLido = item.valorTotalLido != null;
    const alerta = temValorLido && Math.abs(subtotal - item.valorTotalLido) > TOLERANCIA_ABSOLUTA;

    linha.classList.toggle('leitor-item-alerta', alerta);

    const subtotalEl = linha.querySelector('.leitor-item-subtotal');
    if (subtotalEl) subtotalEl.textContent = formatarMoeda(subtotal);

    let avisoEl = linha.querySelector('.leitor-item-aviso');
    if (alerta) {
      const mensagem = `⚠ ${item.quantidade} × ${formatarMoeda(item.valorUnitario)} = ${formatarMoeda(subtotal)}, mas a nota mostra ${formatarMoeda(item.valorTotalLido)}.`;
      if (!avisoEl) {
        avisoEl = document.createElement('p');
        avisoEl.className = 'leitor-item-aviso';
        linha.appendChild(avisoEl);
      }
      avisoEl.textContent = mensagem;
    } else if (avisoEl) {
      avisoEl.remove();
    }

    atualizarBannerTotal();
  }

  /**
   * Quando o usuário edita um campo que a IA tinha marcado como baixa
   * confiança, entendemos que ele já conferiu/corrigiu aquele campo — então
   * o destaque daquele campo específico é removido (o item continua
   * destacado se ainda sobrar algum outro campo incerto nele).
   */
  function limparConfiancaCampo(item, linha, inputEl, nomeCampo) {
    if (!item.camposBaixaConfianca || !item.camposBaixaConfianca.includes(nomeCampo)) return;

    item.camposBaixaConfianca = item.camposBaixaConfianca.filter((c) => c !== nomeCampo);
    inputEl.classList.remove('leitor-baixa-confianca');
    linha.classList.toggle('leitor-item-baixa-confianca', item.camposBaixaConfianca.length > 0);

    let avisoConfiancaEl = linha.querySelector('.leitor-item-confianca');
    if (item.camposBaixaConfianca.length > 0) {
      if (avisoConfiancaEl) {
        avisoConfiancaEl.textContent = `🔍 Conferir: ${listarCamposIncertos(item.camposBaixaConfianca)} — a IA não teve certeza dessa leitura.`;
      }
    } else if (avisoConfiancaEl) {
      avisoConfiancaEl.remove();
    }
  }

  function montarLinhaItemHtml(item) {
    const subtotal = calcularSubtotal(item);
    const temValorLido = item.valorTotalLido != null;
    const alertaCalculo = temValorLido && Math.abs(subtotal - item.valorTotalLido) > TOLERANCIA_ABSOLUTA;
    const camposIncertos = item.camposBaixaConfianca || [];
    const temBaixaConfianca = camposIncertos.length > 0;
    const classeIncerto = (nomeCampo) => (camposIncertos.includes(nomeCampo) ? 'leitor-baixa-confianca' : '');

    return `
      <div class="leitor-item ${alertaCalculo ? 'leitor-item-alerta' : ''} ${temBaixaConfianca ? 'leitor-item-baixa-confianca' : ''}" data-id="${item.id}">
        <div class="leitor-item-linha1">
          <input type="text" class="leitor-campo leitor-campo-descricao ${classeIncerto('descricao')}" value="${escapeHtml(item.descricao)}" placeholder="Descrição da peça" maxlength="120">
          <button type="button" class="leitor-item-remover" data-id="${item.id}" aria-label="Remover item">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="leitor-item-linha2">
          <input type="text" class="leitor-campo leitor-campo-marca ${classeIncerto('marca')}" value="${escapeHtml(item.marca)}" placeholder="Marca (opcional)" maxlength="60">
          <input type="text" class="leitor-campo leitor-campo-codigo ${classeIncerto('codigo')}" value="${escapeHtml(item.codigo)}" placeholder="Código (opcional)" maxlength="60">
        </div>
        <div class="leitor-item-linha3">
          <label class="leitor-campo-rotulo">Qtd.
            <input type="number" class="leitor-campo leitor-campo-qtd ${classeIncerto('quantidade')}" value="${item.quantidade}" min="0" step="0.01" inputmode="decimal">
          </label>
          <label class="leitor-campo-rotulo">Vl. unitário
            <input type="number" class="leitor-campo leitor-campo-valor ${classeIncerto('valorUnitario')}" value="${item.valorUnitario}" min="0" step="0.01" inputmode="decimal">
          </label>
          <span class="leitor-item-subtotal ${classeIncerto('valorTotal')}">${formatarMoeda(subtotal)}</span>
        </div>
        ${alertaCalculo ? `<p class="leitor-item-aviso">⚠ ${item.quantidade} × ${formatarMoeda(item.valorUnitario)} = ${formatarMoeda(subtotal)}, mas a nota mostra ${formatarMoeda(item.valorTotalLido)}.</p>` : ''}
        ${temBaixaConfianca ? `<p class="leitor-item-confianca">🔍 Conferir: ${listarCamposIncertos(camposIncertos)} — a IA não teve certeza dessa leitura.</p>` : ''}
      </div>
    `;
  }

  function renderListaItensRevisao() {
    const container = document.getElementById('leitor-lista-itens');
    if (!container) return;
    container.innerHTML = state.itens.length
      ? state.itens.map(montarLinhaItemHtml).join('')
      : '<p class="os-itens-vazio">Nenhum item nesta nota ainda — adicione manualmente se necessário.</p>';
  }

  function renderRevisao() {
    const somaCalculada = arredondar(state.itens.reduce((soma, item) => soma + calcularSubtotal(item), 0));

    els.corpo.innerHTML = `
      <div class="leitor-revisao">
        <p class="leitor-texto">
          Confira os itens identificados pela IA e corrija o que for preciso antes de lançar na ordem de serviço.
        </p>

        ${state.observacoesIA ? `<p class="leitor-observacao-ia">💡 A IA observou: ${escapeHtml(state.observacoesIA)}</p>` : ''}

        <div id="leitor-lista-itens" class="leitor-lista-itens"></div>

        <button type="button" class="btn-add-item" id="leitor-add-item-manual">+ Adicionar item manualmente</button>

        <div class="leitor-banner-total" id="leitor-banner-total">
          <div class="leitor-banner-linha">
            <span>Soma dos itens</span>
            <strong id="leitor-banner-soma">${formatarMoeda(somaCalculada)}</strong>
          </div>
          <div class="form-group leitor-banner-campo-total">
            <label for="leitor-campo-total-nota">Total impresso na nota <span class="form-optional">(confira e corrija se preciso)</span></label>
            <input type="number" id="leitor-campo-total-nota" class="${state.valorTotalNotaBaixaConfianca ? 'leitor-baixa-confianca' : ''}" min="0" step="0.01" inputmode="decimal" value="${state.valorTotalNota != null ? state.valorTotalNota : ''}" placeholder="Não identificado">
          </div>
          ${state.valorTotalNotaBaixaConfianca ? '<p class="leitor-item-confianca" id="leitor-banner-confianca">🔍 A IA não teve certeza dessa leitura — confira o valor acima.</p>' : ''}
          <p class="leitor-banner-comparacao" id="leitor-banner-comparacao"></p>
        </div>
      </div>
    `;

    els.rodape.innerHTML = `
      <button type="button" class="btn btn-secondary" id="leitor-revisao-cancelar">Cancelar</button>
      <button type="button" class="btn btn-primary" id="leitor-revisao-confirmar">Lançar peças na OS</button>
    `;

    renderListaItensRevisao();
    atualizarBannerTotal();

    const listaEl = document.getElementById('leitor-lista-itens');

    // Delegação de eventos: edição inline sem perder o foco do campo digitado.
    listaEl.addEventListener('input', (e) => {
      const linha = e.target.closest('.leitor-item');
      if (!linha) return;
      const id = linha.dataset.id;
      const item = state.itens.find((i) => i.id === id);
      if (!item) return;

      if (e.target.classList.contains('leitor-campo-descricao')) {
        item.descricao = e.target.value;
        limparConfiancaCampo(item, linha, e.target, 'descricao');
      } else if (e.target.classList.contains('leitor-campo-marca')) {
        item.marca = e.target.value;
        limparConfiancaCampo(item, linha, e.target, 'marca');
      } else if (e.target.classList.contains('leitor-campo-codigo')) {
        item.codigo = e.target.value;
        limparConfiancaCampo(item, linha, e.target, 'codigo');
      } else if (e.target.classList.contains('leitor-campo-qtd')) {
        item.quantidade = Number(e.target.value) || 0;
        limparConfiancaCampo(item, linha, e.target, 'quantidade');
        atualizarLinhaItem(id);
      } else if (e.target.classList.contains('leitor-campo-valor')) {
        item.valorUnitario = Number(e.target.value) || 0;
        limparConfiancaCampo(item, linha, e.target, 'valorUnitario');
        atualizarLinhaItem(id);
      }
    });

    listaEl.addEventListener('click', (e) => {
      const botaoRemover = e.target.closest('.leitor-item-remover');
      if (!botaoRemover) return;
      state.itens = state.itens.filter((i) => i.id !== botaoRemover.dataset.id);
      renderListaItensRevisao();
      atualizarBannerTotal();
    });

    document.getElementById('leitor-campo-total-nota').addEventListener('input', (e) => {
      const valor = e.target.value;
      state.valorTotalNota = valor === '' ? null : Number(valor);
      if (state.valorTotalNotaBaixaConfianca) {
        state.valorTotalNotaBaixaConfianca = false;
        e.target.classList.remove('leitor-baixa-confianca');
        document.getElementById('leitor-banner-confianca')?.remove();
      }
      atualizarBannerTotal();
    });

    document.getElementById('leitor-add-item-manual').addEventListener('click', () => {
      state.itens.push({
        id: gerarId(),
        descricao: '',
        marca: '',
        codigo: '',
        quantidade: 1,
        valorUnitario: 0,
        valorTotalLido: null,
        camposBaixaConfianca: [],
      });
      renderListaItensRevisao();
      atualizarBannerTotal();
      const campos = listaEl.querySelectorAll('.leitor-campo-descricao');
      campos[campos.length - 1]?.focus();
    });

    document.getElementById('leitor-revisao-cancelar').addEventListener('click', fechar);
    document.getElementById('leitor-revisao-confirmar').addEventListener('click', confirmarRevisao);

    abrirOverlay();
  }

  function confirmarRevisao() {
    const itensValidos = state.itens
      .map((item) => ({ ...item, descricao: item.descricao.trim() }))
      .filter((item) => item.descricao && Number(item.quantidade) > 0);

    if (!itensValidos.length) {
      mostrarToast('Adicione ou corrija ao menos um item com descrição e quantidade válidas.', 'erro');
      return;
    }

    const itensParaOS = itensValidos.map((item) => ({
      descricao: item.descricao,
      marca: item.marca?.trim() || null,
      codigo: item.codigo?.trim() || null,
      quantidade: Number(item.quantidade),
      valorUnitario: Number(item.valorUnitario) || 0,
      valorTotalLido: item.valorTotalLido,
      origem: 'notinha',
      confirmada: false,
    }));

    const callback = state.onConfirmar;
    const meta = {
      valorTotalNota: state.valorTotalNota,
      // Imagens da nota (dataURL), pra quem chamou poder fixá-las junto
      // ao registro (ex: OS), e conferir de novo depois.
      imagens: state.imagens.map((img) => img.previewUrl).filter(Boolean),
    };
    fechar();
    if (typeof callback === 'function') {
      callback(itensParaOS, meta);
    }
  }

  /* --------------------------------------------------------------------
     API pública
     -------------------------------------------------------------------- */

  /**
   * Abre o leitor de nota fiscal.
   * @param {{ onConfirmar: (itens: array, meta: {valorTotalNota: number|null, imagens: string[]}) => void }} opcoes
   */
  async function abrir(opcoes = {}) {
    montarModalSeNecessario();

    state.imagens = [];
    state.processandoImagem = false;
    state.itens = [];
    state.valorTotalNota = null;
    state.valorTotalNotaBaixaConfianca = false;
    state.observacoesIA = null;
    state.onConfirmar = opcoes.onConfirmar || null;

    const chaveConfigurada = await ConfiguracoesDB.obter(CHAVE_API_KEY);
    if (!chaveConfigurada) {
      state.etapa = 'config';
      renderConfig();
    } else {
      irParaCaptura();
    }
  }

  return {
    abrir,
  };
})();
