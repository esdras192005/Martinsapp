/* ======================================================================
   MARTINS — core/dicionarioPecas.js
   Dicionário interno de peças automotivas e marcas + correção
   ortográfica aproximada.

   Objetivo: depois que a IA/OCR lê uma nota fiscal, pequenos erros de
   leitura são comuns (ex.: "Filtr de Oleo", "Boch", "Pastilha de Freoo").
   Este módulo compara cada texto lido com uma lista de termos
   conhecidos (nomes de peças comuns em oficina + marcas do mercado
   brasileiro) e, quando encontra um termo muito parecido (mas não
   idêntico), troca pelo termo correto — sem mexer em mais nada do
   fluxo do leitor.

   Este módulo é só leitura/consulta: não grava nada no IndexedDB e não
   depende de nenhum outro módulo do app (pode ser usado por qualquer
   um, mas hoje é consumido só por js/modules/leitorNota.js).

   Uso público:
     DicionarioPecas.corrigirDescricao('Filtr de Oleo')   -> 'Filtro de Óleo'
     DicionarioPecas.corrigirMarca('Boch')                -> 'Bosch'
   Se nada parecido o suficiente for encontrado, devolve o texto
   original sem alteração (evita "corrigir" algo que já está certo,
   ou que é um item real que só não está no dicionário).
   ====================================================================== */

const DicionarioPecas = (() => {

  /* --------------------------------------------------------------------
     Dicionário de nomes de peças automotivas mais comuns em oficinas
     mecânicas. Não precisa ser exaustivo — cobre os itens mais lidos
     em notas fiscais de autopeças, que é onde erro de OCR mais custa
     caro (o resto o usuário corrige na revisão manual mesmo).
     -------------------------------------------------------------------- */
  const NOMES_PECAS = [
    'Filtro de Óleo', 'Filtro de Ar', 'Filtro de Combustível', 'Filtro de Cabine',
    'Filtro de Ar Condicionado', 'Óleo Motor', 'Óleo de Câmbio', 'Óleo Hidráulico',
    'Vela de Ignição', 'Cabo de Vela', 'Bobina de Ignição', 'Bateria',
    'Pastilha de Freio', 'Disco de Freio', 'Tambor de Freio', 'Lona de Freio',
    'Fluido de Freio', 'Cilindro de Freio', 'Mangueira de Freio',
    'Correia Dentada', 'Correia do Alternador', 'Correia Poly-V', 'Tensor da Correia',
    'Kit Correia Dentada', 'Kit Embreagem', 'Disco de Embreagem', 'Platô de Embreagem',
    'Rolamento de Embreagem', 'Atuador de Embreagem',
    'Amortecedor Dianteiro', 'Amortecedor Traseiro', 'Kit Amortecedor',
    'Mola Helicoidal', 'Batente de Amortecedor', 'Coxim do Motor', 'Coxim do Câmbio',
    'Bandeja de Suspensão', 'Bieleta', 'Pivô de Suspensão', 'Terminal de Direção',
    'Barra de Direção', 'Caixa de Direção', 'Bomba de Direção Hidráulica',
    'Rolamento de Roda', 'Rolamento Dianteiro', 'Rolamento Traseiro',
    'Junta Homocinética', 'Coifa da Homocinética', 'Semieixo',
    'Radiador', 'Radiador de Água', 'Reservatório de Água', 'Válvula Termostática',
    'Mangueira do Radiador', 'Ventoinha do Radiador', 'Bomba d\'Água',
    'Bomba de Combustível', 'Bico Injetor', 'Sonda Lambda', 'Sensor de Oxigênio',
    'Sensor de Rotação', 'Sensor de Temperatura', 'Sensor MAP', 'Sensor de Fase',
    'Junta do Cabeçote', 'Junta do Cárter', 'Retentor', 'Retentor de Válvula',
    'Bronzina', 'Anel de Pistão', 'Pistão', 'Biela', 'Comando de Válvula',
    'Válvula de Escape', 'Válvula de Admissão', 'Coletor de Escape', 'Coletor de Admissão',
    'Catalisador', 'Silencioso', 'Escapamento', 'Cano de Escapamento',
    'Alternador', 'Motor de Partida', 'Relé', 'Fusível', 'Chicote Elétrico',
    'Lâmpada Farol', 'Lâmpada de Seta', 'Farol', 'Lanterna Traseira', 'Palheta do Limpador',
    'Motor do Limpador', 'Reservatório do Limpador', 'Aditivo do Radiador',
    'Pneu', 'Câmara de Ar', 'Roda', 'Calota', 'Amortecedor de Capô',
    'Espelho Retrovisor', 'Maçaneta', 'Trava Elétrica', 'Vidro Elétrico',
    'Kit Gás', 'Compressor de Ar Condicionado', 'Condensador', 'Válvula de Expansão',
    'Correia do Compressor', 'Polia do Virabrequim', 'Amortecedor de Vibração',
    'Bucha de Suspensão', 'Bucha da Bandeja', 'Cubo de Roda', 'Parafuso de Roda',
  ];

  /* --------------------------------------------------------------------
     Dicionário de marcas de autopeças mais comuns no mercado brasileiro.
     -------------------------------------------------------------------- */
  const MARCAS_PECAS = [
    'Bosch', 'NGK', 'Fram', 'Tecfil', 'Cofap', 'Nakata', 'Mahle', 'Sabó',
    'Fras-le', 'Monroe', 'Varga', 'DPK', 'Continental', 'Valeo', 'ZF',
    'TRW', 'Wega', 'Ferrox', 'Metal Leve', 'MTE-Thomson', 'Delphi', 'Denso',
    'Hipper Freios', 'Magneti Marelli', 'Fremax', 'HiperFreios', 'Frasle',
    'SKF', 'FAG', 'NTN', 'Timken', 'Dayco', 'Gates', 'Contitech', 'Akebono',
    'Bendix', 'Controil', 'Ceramic Pads', 'Renault Original', 'Fiat Original',
    'GM Original', 'VW Original', 'Ford Original', 'Original Toyota',
    'Iprimi', 'Ford Motorcraft', 'Motorcraft', 'Champion', 'AC Delco',
    'Bremen', 'Rimen', 'Codimapel', 'Master', 'Sabo', 'Cummins',
    'Metalcar', 'Ambras', 'Sasa', 'Jtec', 'Kolbenschmidt', 'KS',
    'Autopel', 'Firestone', 'Pirelli', 'Michelin', 'Goodyear', 'Continental Pneus',
    'Osram', 'Philips', 'GE Lighting', 'Hella', 'Lucas', 'Bremax',
    'Original Honda', 'Original Hyundai', 'Original Chevrolet', 'Original Nissan',
  ];

  /* --------------------------------------------------------------------
     Distância de Levenshtein — número mínimo de inserções, remoções ou
     trocas de caractere para transformar uma string na outra. Quanto
     menor, mais parecidas as strings são.
     -------------------------------------------------------------------- */
  function distanciaLevenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let linhaAnterior = Array.from({ length: b.length + 1 }, (_, i) => i);
    let linhaAtual = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
      linhaAtual[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const custo = a[i - 1] === b[j - 1] ? 0 : 1;
        linhaAtual[j] = Math.min(
          linhaAnterior[j] + 1,      // remoção
          linhaAtual[j - 1] + 1,     // inserção
          linhaAnterior[j - 1] + custo, // substituição
        );
      }
      [linhaAnterior, linhaAtual] = [linhaAtual, linhaAnterior];
    }
    return linhaAnterior[b.length];
  }

  /** Normaliza para comparação: minúsculas e sem acento. */
  function normalizar(texto) {
    return (texto || '')
      .toString()
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Similaridade entre 0 (nada parecido) e 1 (idêntico), baseada na
   * distância de Levenshtein normalizada pelo tamanho da maior string.
   */
  function similaridade(a, b) {
    const na = normalizar(a);
    const nb = normalizar(b);
    if (!na || !nb) return 0;
    const maiorTamanho = Math.max(na.length, nb.length);
    if (!maiorTamanho) return 1;
    return 1 - distanciaLevenshtein(na, nb) / maiorTamanho;
  }

  // Regra de correção baseada em distância absoluta de edição (mais
  // previsível que uma simples porcentagem para palavras curtas): quanto
  // maior o termo do dicionário, mais "erros de leitura" ele tolera
  // antes de deixar de ser considerado o mesmo termo. Termos com menos
  // de 4 letras (ex.: siglas de marca como "ZF", "KS") nunca são
  // corrigidos por aproximação — o risco de trocar por engano é maior
  // que o ganho.
  function distanciaMaximaTolerada(tamanhoTermo) {
    if (tamanhoTermo < 3) return 0;
    if (tamanhoTermo <= 6) return 1;
    if (tamanhoTermo <= 10) return 2;
    return 3;
  }

  /**
   * Decide se um termo do dicionário "bate" com o texto lido inteiro,
   * e por qual distância. Não lida com prefixo/sobra — isso é tratado
   * à parte em corrigirTexto, palavra por palavra, para nunca descartar
   * informação real (ex.: "Dianteira", código, aplicação do veículo)
   * que às vezes vem colada depois do nome da peça.
   */
  function bateComTermo(textoNormalizado, termoNormalizado) {
    const distancia = distanciaLevenshtein(textoNormalizado, termoNormalizado);
    if (distancia === 0) return { distancia: 0 };
    const tolerancia = distanciaMaximaTolerada(termoNormalizado.length);
    return distancia <= tolerancia ? { distancia } : null;
  }

  /**
   * Corrige um texto comparando com uma lista de termos conhecidos.
   * Primeiro tenta o texto inteiro contra cada termo; se não bater,
   * e o texto tiver mais palavras que o termo mais parecido (ex.: nome
   * da peça seguido da aplicação do veículo), tenta bater só as
   * primeiras N palavras — e, nesse caso, troca SOMENTE essas palavras
   * pelo termo correto, preservando o restante do texto original
   * (nunca descarta informação extra que não seja o próprio nome/marca).
   */
  function corrigirTexto(textoLido, listaTermos) {
    if (!textoLido) return textoLido;
    const textoOriginal = textoLido.toString().trim();
    const textoNormalizadoCompleto = normalizar(textoOriginal);
    if (!textoNormalizadoCompleto) return textoLido;

    const palavrasOriginais = textoOriginal.split(/\s+/);

    let melhor = null; // { termo, distancia, palavrasConsumidas }

    for (const termo of listaTermos) {
      const termoNormalizado = normalizar(termo);

      // 1) Texto inteiro vs. termo inteiro.
      const correspondenciaTotal = bateComTermo(textoNormalizadoCompleto, termoNormalizado);
      if (correspondenciaTotal && (!melhor || correspondenciaTotal.distancia < melhor.distancia)) {
        melhor = { termo, distancia: correspondenciaTotal.distancia, palavrasConsumidas: palavrasOriginais.length };
      }

      // 2) Primeiras N palavras (N = qtde de palavras do termo) vs. termo,
      // deixando o resto do texto original intacto.
      const numPalavrasTermo = termo.trim().split(/\s+/).length;
      if (numPalavrasTermo < palavrasOriginais.length) {
        const prefixoNormalizado = normalizar(palavrasOriginais.slice(0, numPalavrasTermo).join(' '));
        const correspondenciaPrefixo = bateComTermo(prefixoNormalizado, termoNormalizado);
        if (correspondenciaPrefixo && (!melhor || correspondenciaPrefixo.distancia < melhor.distancia)) {
          melhor = { termo, distancia: correspondenciaPrefixo.distancia, palavrasConsumidas: numPalavrasTermo };
        }
      }
    }

    if (!melhor) return textoLido;

    const restante = palavrasOriginais.slice(melhor.palavrasConsumidas).join(' ');
    const textoCorrigido = restante ? `${melhor.termo} ${restante}` : melhor.termo;

    // Se a distância é 0 (já batia, ignorando acento/maiúsculas), só
    // vale a pena aplicar se isso muda algo de fato (padroniza acento
    // ou maiúsculas) — nunca "corrige" um texto que já estava idêntico.
    if (melhor.distancia === 0 && textoCorrigido === textoOriginal) {
      return textoLido;
    }

    return textoCorrigido;
  }

  /**
   * Corrige um texto de descrição de peça comparando com o dicionário
   * de nomes conhecidos. Se o texto lido já bater exatamente com um
   * termo (ignorando acento/maiúsculas) ou não for parecido o
   * suficiente com nenhum termo, devolve o texto original sem alterar.
   */
  function corrigirDescricao(textoLido) {
    return corrigirTexto(textoLido, NOMES_PECAS);
  }

  /**
   * Corrige um texto de marca comparando com o dicionário de marcas
   * conhecidas, nas mesmas regras de corrigirDescricao.
   */
  function corrigirMarca(textoLido) {
    return corrigirTexto(textoLido, MARCAS_PECAS);
  }

  /**
   * Aplica as duas correções acima a um item de nota já extraído,
   * devolvendo uma cópia do item com "descricao"/"marca" corrigidas e
   * um resumo do que foi ajustado (útil para log ou aviso na tela,
   * sem que seja obrigatório usar essa parte).
   */
  function corrigirItem(item) {
    const descricaoCorrigida = corrigirDescricao(item.descricao);
    const marcaCorrigida = item.marca ? corrigirMarca(item.marca) : item.marca;

    const correcoes = [];
    if (descricaoCorrigida !== item.descricao) {
      correcoes.push({ campo: 'descricao', original: item.descricao, corrigido: descricaoCorrigida });
    }
    if (marcaCorrigida !== item.marca) {
      correcoes.push({ campo: 'marca', original: item.marca, corrigido: marcaCorrigida });
    }

    return {
      item: { ...item, descricao: descricaoCorrigida, marca: marcaCorrigida },
      correcoes,
    };
  }

  return {
    NOMES_PECAS,
    MARCAS_PECAS,
    corrigirDescricao,
    corrigirMarca,
    corrigirItem,
    // Exposto para testes/depuração manual, se precisar no console.
    _similaridade: similaridade,
  };
})();
