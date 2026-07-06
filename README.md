# Martins — Gestão de Oficina Mecânica

Fundação do aplicativo, preparada para virar um APK Android (via Capacitor ou similar).

## Revisão geral (changelog desta rodada)

Esta rodada não adicionou nem removeu nenhuma funcionalidade — o foco foi
qualidade, consistência visual e organização do código:

- **Novo `js/core/utils.js`**: as funções `formatarMoeda`, `formatarData`,
  `escapeHtml`, `mostrarToast` e a montagem do modal (bottom sheet), que
  antes eram copiadas e coladas em cada um dos 6 módulos de tela, agora
  vivem num único lugar. Cada módulo continua chamando essas funções com
  os mesmos nomes de sempre (`formatarMoeda(...)`, `abrirModal(...)`,
  etc.) — só a implementação interna deixou de estar duplicada.
- **Bug corrigido no fechamento de modais**: ao fechar um modal, o app
  agora só destrava o scroll do body se não houver *outro* modal aberto
  por baixo (ex: leitor de nota fiscal sobre o formulário de OS) — antes
  esse cuidado só existia no leitor de nota; agora é garantido em todos
  os modais do app.
- **Acessibilidade por teclado**: todos os cards clicáveis das listagens
  (Clientes, Ordens, Orçamentos, Despesas, Peças) agora têm
  `role="button"`/`tabindex` e respondem a Enter/Espaço, com um anel de
  foco visível consistente — antes só o histórico de OS no detalhe do
  cliente tinha isso.
- **CSS consolidado**: `.os-card`, `.orc-card`, `.despesa-card` e
  `.peca-card` compartilhavam quase o mesmo código (mesma anatomia,
  copiada 4 vezes) — agora a "casca" comum vive uma única vez na seção 9
  (Componentes reutilizáveis) e cada tela só define o que é realmente
  específico dela. De quebra, corrige uma pequena inconsistência onde o
  card de peça não mostrava cursor de "clicável" como os outros.
- **Toasts empilháveis**: dois avisos em sequência rápida agora aparecem
  um acima do outro, em vez de um substituir o outro no mesmo lugar.
- **`prefers-reduced-motion` mais abrangente**: cobre modal, toast, fab,
  botões e cards, não só a troca de view e o ícone do menu.
- **Índice de seções do CSS corrigido**: estava desatualizado e tinha
  duas seções numeradas como "15".
- **PWA / preparação para APK**: `manifest.json`, `service-worker.js`
  (cache do app shell para abrir instantâneo e funcionar offline) e
  ícones em `icons/` — ver seção própria abaixo.
- **Carregamento mais rápido**: os scripts do banco de dados local
  passaram a usar `defer` (antes bloqueavam o parser da página); a ordem
  de execução continua a mesma.

## Estrutura de pastas

```
martins/
├── index.html            # Shell do app: header, views, menu de navegação, manifest/PWA
├── manifest.json          # Metadados do PWA (nome, ícones, cor de tema)
├── service-worker.js       # Cache do app shell para abertura instantânea e uso offline
├── icons/                  # Ícones do PWA (192px, 512px e versão "maskable")
├── css/
│   └── style.css          # Design tokens + todos os estilos, organizados por seção numerada
├── js/
│   ├── app.js               # Navegação entre telas + inicialização do banco + service worker
│   ├── core/
│   │   └── utils.js          # Formatação, toast e modal compartilhados por todas as telas
│   ├── db/                   # Banco de dados local (IndexedDB) — ver seção própria
│   └── modules/               # Uma funcionalidade de TELA por arquivo
│       ├── clientes.js
│       ├── ordens.js
│       ├── orcamentos.js
│       ├── financeiro.js
│       ├── estoque.js
│       └── leitorNota.js        # Recurso (não é uma tela própria) usado dentro de Ordens
└── README.md
```

## Banco de dados local (`js/db/`)

Implementado em IndexedDB, sem dependências externas. Um arquivo por tabela,
todos por cima de um núcleo genérico:

```
js/db/
├── database.js       # MartinsDB — abre o banco, cria as tabelas, CRUD genérico
├── clientes.js        # ClientesDB
├── veiculos.js         # VeiculosDB
├── ordens.js           # OrdensDB     (ordensServico)
├── orcamentos.js       # OrcamentosDB (orcamentos)
├── despesas.js         # DespesasDB   (despesas)
├── pecas.js            # PecasDB
├── maoDeObra.js        # MaoDeObraDB
└── configuracoes.js    # ConfiguracoesDB (chave-valor)
```

Cada módulo de entidade expõe os mesmos verbos básicos — `criar`,
`buscarPorId`, `listarTodos`/`listarTodas`, `atualizar`, `excluir` — mais
buscas específicas (ex: `VeiculosDB.buscarPorPlaca`, `OrdensDB.listarPorStatus`,
`PecasDB.listarEstoqueBaixo`, `PecasDB.ajustarEstoque`).

`MartinsDB.init()` roda automaticamente ao carregar o app (em `app.js`),
antes de qualquer módulo de entidade ser usado. Todas as 6 telas (Clientes,
Ordens, Orçamentos, Financeiro, Estoque e o leitor de nota fiscal) já
estão implementadas por cima dessa camada.

Para adicionar uma nova tabela ou índice no futuro: suba `DB_VERSION` em
`database.js` e adicione o bloco de criação em `criarEsquema()` — os dados
já existentes não são apagados na migração.

## Como adicionar uma nova funcionalidade

1. As views (Ordens, Clientes, Estoque, Financeiro, Orçamentos) existem como
   seções em `index.html` (`<section class="view" data-view="...">`). Uma
   view pode ficar vazia — o próprio módulo JS monta o conteúdo dentro dela
   (é o que `js/modules/clientes.js` faz).
2. Crie `js/modules/nome-da-feature.js` seguindo o padrão comentado no fim
   de `app.js` (objeto com `name`, `init()` e `onNavigate()`).
3. No topo do módulo, puxe o que precisar de `js/core/utils.js` em vez de
   reimplementar: `const { formatarMoeda, formatarData, escapeHtml,
   mostrarToast } = Utils;`. Para o modal (bottom sheet), use
   `Utils.criarModal('sua-tela-modal-overlay')` dentro do seu
   `montarModal()` — veja `js/modules/clientes.js` como referência mínima.
4. No fim do arquivo do módulo, chame `App.modules.register(SeuModulo)`.
5. Inclua o `<script src="js/modules/nome-da-feature.js" defer></script>`
   no `index.html`, **depois** de `js/core/utils.js` e de `app.js` (nessa
   ordem: utilitários e `App` primeiro; os módulos vêm em seguida e já
   podem usar `Utils`/`App.modules.register` porque ambos já existem).
6. Estilos específicos da feature podem entrar direto em `style.css`, numa
   nova seção comentada (o arquivo já é dividido por índice numerado, ver
   o topo do arquivo). Botões, formulários, modal (bottom sheet), toast,
   FAB e o card de listagem genérico já existem como componentes
   reutilizáveis na seção 9 — não recrie esses estilos por feature, só
   reaproveite as classes (`.btn`, `.btn-primary`, `.modal-*`,
   `.form-group`, `.fab`, `.toast`, `.os-card`/`.orc-card`/etc.).

Isso evita que `app.js` e `style.css` virem arquivos gigantes conforme o
app cresce — cada funcionalidade fica isolada no seu próprio arquivo.

## Módulo de Clientes (`js/modules/clientes.js`)

Primeira funcionalidade completa do app. Referência de padrão para as
próximas (Ordens, Estoque, Financeiro):

- **Listagem + busca**: `view-toolbar` com campo de busca (debounce de
  200ms) que filtra por nome, telefone, CPF ou endereço via
  `ClientesDB.pesquisar()`.
- **Cartão de cliente**: nome, telefone formatado e um botão de atalho
  para abrir o WhatsApp (`wa.me`), sem precisar entrar no detalhe.
- **Modal único reutilizável** (`montarModal()` em `clientes.js`): um só
  overlay de bottom-sheet serve para formulário, detalhe do cliente e
  confirmação de exclusão — o conteúdo é trocado, não há modais aninhados.
- **Detalhe do cliente**: mostra telefone, CPF, endereço, observações,
  data de cadastro e a lista de veículos vinculados (via
  `VeiculosDB.listarPorCliente`), já preparado para quando a tela de
  veículos existir — hoje só mostra "nenhum veículo vinculado ainda".
- **Máscaras**: telefone e CPF ganham máscara visual ao digitar, mas são
  salvos no banco só com dígitos (`ClientesDB` normaliza isso); a
  formatação para exibição fica no módulo de tela, não na camada de dados.
- **Validação**: nome e telefone são obrigatórios; CPF, endereço e
  observações são opcionais (CPF, se informado, precisa ter 11 dígitos).

Para o módulo de Veículos aproveitar essa base: reutilize os componentes
da seção 9 do CSS, o padrão de modal único e o campo `clienteId` já
existente em `js/db/veiculos.js` (`VeiculosDB.listarPorCliente`,
`VeiculosDB.criar`).

## Módulo de Orçamentos (`js/modules/orcamentos.js` + `js/db/orcamentos.js`)

Um orçamento **não é uma Ordem de Serviço**: é uma proposta de valores para
o cliente aprovar antes de qualquer serviço começar. Por isso vive na sua
própria tabela (`orcamentos`, em `js/db/orcamentos.js`), com seu próprio
ciclo de vida, e só vira uma OS quando alguém decide convertê-lo.

- **Tela própria**: view `orcamentos`, entre "Ordens" e "Clientes" no menu
  inferior. Segue exatamente o mesmo padrão de `js/modules/ordens.js`
  (listagem com busca + chips de filtro, modal único de formulário/detalhe/
  exclusão, FAB para criar).
- **Formulário**: cliente e veículo (obrigatórios, com o mesmo filtro
  encadeado cliente → veículo da OS), data do orçamento, validade
  (opcional), status inicial, observações (opcional) e as seções de
  Peças/Mão de obra — mesmos subformulários e mesma lista de itens da OS
  (reaproveita as classes CSS `.os-item-row`, `.os-form-secao`, etc.). O
  valor total é recalculado ao vivo a cada peça/serviço adicionado ou
  removido (`OrcamentosDB.calcularValorTotal`).
- **Status**: `pendente` (padrão) | `aprovado` | `recusado`. No detalhe do
  orçamento, três botões (`.orc-status-btn`) trocam o status com um toque,
  a qualquer momento — não é um fluxo linear como o da OS.
- **Duplicar**: cria um novo orçamento (novo id, status `pendente`, sem
  validade, sem vínculo de conversão) com os mesmos cliente/veículo/itens/
  observações do original, e já abre o formulário do novo para ajustes —
  mesmo padrão de `OrdensDB.duplicar`.
- **Converter em OS com um clique** (`OrcamentosDB.converterEmOrdem`):
  chama `OrdensDB.criar` passando cliente, veículo, peças e mão de obra do
  orçamento (as observações viram a descrição dos serviços da OS) — nada é
  perdido. O orçamento **não é apagado nem substituído**: ganha
  `convertidoEmOrdemId`/`convertidoEm` e passa para o status `aprovado`,
  mas continua no histórico normalmente. Um orçamento só pode ser
  convertido uma vez (duplique-o para gerar outra OS a partir dos mesmos
  dados). Ao converter, a tela fecha o modal do orçamento e abre
  diretamente o detalhe da OS recém-criada (via
  `OrdensModule.abrirDetalhePorId`, por isso `orcamentos.js` precisa
  carregar depois de `ordens.js` no `index.html`).
- **Histórico**: `OrcamentosDB.listarTodos()` nunca filtra por status —
  a tela mostra sempre todos os orçamentos (pendentes, aprovados,
  recusados e convertidos), com chips de filtro opcionais, incluindo um
  chip "Convertidos em OS" para achar rapidamente o histórico de
  conversões.
- **Excluir** um orçamento nunca afeta a OS que ele já tenha gerado (cada
  uma guarda sua própria cópia dos itens, como as demais entidades deste
  banco).

## Módulo de Financeiro (`js/modules/financeiro.js` + `js/db/despesas.js`)

Um dashboard financeiro completo da oficina, dividido em duas metades:

- **Entradas**: calculadas em tempo real a partir das Ordens de Serviço
  com status `finalizada` ou `entregue` (`OrdensDB`). Não existe uma
  tabela própria de "receitas" — isso evita duplicar dados e garante que
  o Financeiro nunca fica dessincronizado da OS real. A "data da
  receita" de cada OS é `dataConclusao` (ou `dataEntrega`/`dataAbertura`
  como fallback).
- **Saídas**: a nova tabela `despesas` (`DespesasDB`, em
  `js/db/despesas.js`), para lançamento manual de aluguel, ferramentas,
  energia, água, internet, impostos e outras despesas, com valor, data
  de vencimento, data de pagamento (opcional) e status
  (`pendente`/`pago`).

**Dashboard** (`#fin-dashboard`, recalculado a cada `onNavigate()`):
- 4 cards de faturamento — **hoje, esta semana, este mês, este ano** —
  cada um com a variação percentual em relação ao período equivalente
  anterior.
- Resumo do mês atual: **lucro líquido** (faturamento do mês − despesas
  pagas no mês), **peças faturadas**, **mão de obra recebida**,
  **despesas pagas** e **contas a pagar** (soma de todas as despesas
  pendentes, com contagem de vencidas). Tocar no card "Contas a pagar"
  já filtra a lista de despesas abaixo para "Pendentes".
- Dois **gráficos de evolução** dos últimos 6 meses — faturamento vs.
  despesas (barras) e lucro líquido (linha) — desenhados em SVG puro
  (`montarGraficoComparativo`/`montarGraficoLucro`), já que o app não
  tem pipeline de build para usar uma biblioteca de gráficos.

**Gestão de despesas** (`#fin-secao-despesas`): lista com busca, chips
de status (Todas/Pendentes/Pagas) e filtro por categoria, seguindo o
mesmo padrão de tela das demais (FAB para criar, modal único de
formulário/detalhe/exclusão). No detalhe de uma despesa dá para marcar
como paga/pendente com um toque, duplicá-la para o mês seguinte (atalho
para contas fixas recorrentes, sem precisar de um motor de repetição
automática) ou excluí-la.

## Leitor de nota fiscal por IA (`js/modules/leitorNota.js`)

Acionado pelo botão "Ler nota fiscal" na seção de Peças do formulário de
Ordens de Serviço. Não é uma "tela" registrada em `App.modules` — é um
recurso que abre seu próprio modal por cima do formulário já aberto.

- **Captura**: o usuário tira ou escolhe 1+ fotos (nota com várias
  páginas é tratada como uma única compra). As imagens são redimensionadas
  no próprio dispositivo antes do envio (`LIMITE_LADO_MAIOR_PX`).
- **IA**: chama a Claude API (Anthropic) diretamente do dispositivo, com
  um prompt que instrui a IA a extrair **somente itens de peça**
  (descrição, marca, código, quantidade, valor unitário, valor total),
  ignorando dados da empresa/CNPJ/endereço/impostos/forma de pagamento,
  e a devolver o valor total geral da nota. A chave de API fica salva
  localmente em `ConfiguracoesDB` (chave `leitorNotaApiKey`) — pedida ao
  usuário na primeira vez que o recurso é usado.
- **Validação de cálculo**: cada item tem seu subtotal (quantidade ×
  valor unitário) comparado com o valor de linha lido da nota, e a soma
  de todos os itens é comparada com o total geral da nota — divergências
  acima de uma pequena tolerância de arredondamento acendem um aviso
  visual, sem bloquear o usuário.
- **Revisão obrigatória**: todo campo de todo item é editável antes de
  confirmar (inclusive o total da nota, caso a IA leia errado), e dá
  para adicionar itens manualmente ou remover itens que a IA identificou
  por engano.
- **Integração com a OS**: ao confirmar, os itens entram em
  `state.formPecas` do formulário de Ordens (mesmo array usado pela
  peça manual/catálogo), com `origem: 'notinha'` e `confirmada: false`
  — a OS ainda não é salva automaticamente; o usuário revisa a lista
  completa no formulário e só grava ao clicar em "Salvar". Isso significa
  que o total da OS nunca é calculado a partir do que a IA leu direto:
  é sempre quantidade × valor unitário das linhas já revisadas (ver
  `OrdensDB.calcularValorTotal`).
- Modelo padrão: `claude-sonnet-5` (configurável via `ConfiguracoesDB`,
  chave `leitorNotaModelo`, caso um modelo mais novo seja lançado).

## Fotos da Ordem de Serviço (`js/modules/ordens.js` + `js/db/ordens.js`)

Cada OS ganhou uma galeria de fotos própria, dentro do detalhe da ordem
(não é uma tela nova nem um módulo separado — vive junto de
`js/modules/ordens.js`, na função `abrirDetalhe`):

- **Captura**: botão "+ Adicionar foto" abre um mini formulário (mesmo
  padrão visual do "+ Adicionar" de peças/mão de obra) com um seletor de
  **momento** (Antes / Durante / Depois) e um botão único "Tirar foto /
  Escolher da galeria" — o `<input type="file" accept="image/*">` deixa o
  próprio sistema operacional oferecer câmera ou galeria, do mesmo jeito
  que o leitor de nota fiscal já faz. A foto é redimensionada localmente
  (Canvas, lado maior limitado a 1600px, JPEG 82%) antes de virar um data
  URL — sem overhead do pré-processamento de OCR do leitor de nota, que
  não se aplica aqui.
- **Legenda**: opcional, tanto no momento de adicionar quanto depois
  (toque na legenda dentro do visualizador de zoom para editá-la a
  qualquer momento).
- **Organização**: a galeria agrupa as fotos por momento (Antes/Durante/
  Depois), mostrando só os grupos que têm pelo menos uma foto.
- **Zoom**: toque em qualquer miniatura abre um visualizador em tela
  cheia (`abrirVisualizadorFoto`), com navegação entre fotos (setas/
  teclado), toque na imagem para ampliar/reduzir e suporte ao gesto
  nativo de pinça do navegador.
- **Persistência**: cada foto vira um item em `ordem.fotos` (ver
  `js/db/ordens.js`), gravado direto no registro da OS no IndexedDB —
  sem tabela nova, sem upload a servidor (o app é local/offline). OS
  criadas antes deste recurso simplesmente não têm o campo (tratado como
  lista vazia). Duplicar uma OS (`OrdensDB.duplicar`) não copia as fotos
  — a cópia começa sem registro visual do serviço original.
- **PDF**: `gerarPdfOrdem` inclui automaticamente uma seção "Fotos do
  serviço" (também agrupada por Antes/Durante/Depois, com a legenda como
  legenda de figura) sempre que a OS tiver ao menos uma foto — sem
  nenhuma ação extra do usuário.
- **Remover**: cada miniatura tem um botão de remoção com confirmação;
  não afeta peças, mão de obra ou o valor total da OS.

## Checklist da Ordem de Serviço (`js/modules/ordens.js` + `js/db/ordens.js`)

Seção "Checklist do serviço", dentro do detalhe da OS, logo acima de
Peças/Mão de obra. Lista de tarefas livre (ex: "Trocar óleo", "Testar
freios"), específica de cada OS — não existe um checklist global
compartilhado entre ordens, então ele já nasce "personalizado" por
veículo/serviço sem precisar de uma tela extra de templates:

- **Adicionar item**: campo de texto + botão "Adicionar" (ou Enter), e
  chips de sugestão rápida (`SUGESTOES_CHECKLIST`, em
  `js/modules/ordens.js`) com tarefas comuns de oficina — só atalhos
  para digitar mais rápido; um chip some da lista assim que o item
  correspondente já foi adicionado.
- **Concluir**: toque no item marca/desmarca como concluído (checkbox
  próprio, com risco no texto quando concluído) e grava `concluidoEm`.
  Ao contrário da seção de fotos, aqui a tela não recarrega o detalhe
  inteiro a cada toque — atualiza só a lista localmente (update
  otimista com reversão se a gravação falhar), pensando em marcar vários
  itens em sequência durante o serviço.
- **Progresso**: contador "X de Y concluídos" acima da lista.
- **Remover**: cada item tem um botão de remoção com confirmação.
- **Persistência**: cada item vira uma entrada em `ordem.checklist` (ver
  `js/db/ordens.js`), gravada direto no registro da OS — sem tabela
  nova, sem servidor. OS criadas antes deste recurso não têm o campo
  (tratado como lista vazia).
- **Duplicar OS** (`OrdensDB.duplicar`): o checklist É copiado (é a lista
  de tarefas daquele tipo de serviço, útil de reaproveitar), mas todos
  os itens voltam para "pendente" — ao contrário das fotos, que nunca
  são copiadas.
- **PDF**: `gerarPdfOrdem` inclui uma seção "Checklist do serviço" (com
  ☑/☐ e risco nos itens concluídos) logo após a descrição do serviço,
  sempre que a OS tiver ao menos um item — sem ação extra do usuário.

## Módulo de Estoque (`js/modules/estoque.js` + `js/db/pecas.js`)

Catálogo de peças da oficina, reaproveitado pelos formulários de Ordens e
Orçamentos (o select "Peça do estoque" busca daqui).

- **Listagem + busca + estoque baixo**: mesmo padrão de tela das demais
  (busca com debounce, FAB para criar), com destaque visual para peças
  no ou abaixo do estoque mínimo (`PecasDB.listarEstoqueBaixo`,
  `estaBaixo()`).
- **Cadastro**: nome, marca/código (opcionais), preço de custo e de
  venda, quantidade em estoque e estoque mínimo, fornecedor (opcional).
- **Entrada por nota fiscal**: o botão de leitor de nota fiscal também
  está disponível aqui, para dar entrada em peças compradas direto no
  estoque (mesmo `LeitorNotaFiscal.abrir`, usado também em Ordens).
- **Ajuste de estoque**: `PecasDB.ajustarEstoque` soma/subtrai a
  quantidade sem precisar reabrir o formulário completo de edição.

## PWA e empacotamento como APK

O app já é um PWA instalável (`manifest.json` + `service-worker.js` +
`icons/`), o que serve de base direta para o empacotamento nativo:

- **Testar a instalação**: sirva a pasta por HTTPS (ou `localhost`) e use
  "Adicionar à tela inicial" no Chrome Android — o service worker cacheia
  o app shell (HTML/CSS/JS/ícones) na primeira visita, então aberturas
  seguintes são instantâneas e funcionam offline. Os dados (clientes,
  OS, estoque...) sempre funcionaram offline, pois vivem só no
  IndexedDB local — o service worker só cuida dos arquivos do app em si.
- **Publicar uma atualização**: suba `CACHE_VERSION` em
  `service-worker.js`; o cache antigo é limpo automaticamente na
  próxima abertura do app.
- **Virar APK**: este projeto pode ser usado como `webDir` de um projeto
  Capacitor sem alterações estruturais, ou empacotado como TWA (Trusted
  Web Activity) usando o próprio `manifest.json` já existente.

## Design

- Tema "oficina": fundo cinza-chumbo, acento laranja de segurança (`--color-accent`),
  amarelo de alerta usado com moderação (`--color-warning`).
- Tipografia: Oswald (títulos/identidade) + Inter (corpo/leitura).
- Menu inferior fixo, no estilo de apps Android nativos, já com os 5
  espaços reservados: Início, Ordens, Clientes, Estoque, Financeiro.
- Todas as variáveis de cor/espaçamento ficam no topo de `style.css`,
  em `:root` — mude ali para ajustar o visual em um único lugar.

## Próximos passos sugeridos

- Testar a instalação do PWA num Android real e, se fizer sentido,
  empacotar como APK via Capacitor ou TWA.
- Considerar sincronização/backup em nuvem (hoje os dados vivem só no
  IndexedDB do dispositivo).
