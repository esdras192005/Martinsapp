/* ======================================================================
   MARTINS — service-worker.js
   Cache do "app shell" (HTML/CSS/JS/ícones) para abrir instantaneamente
   e continuar funcionando offline. Os dados do app (clientes, ordens,
   estoque, etc.) NUNCA passam por aqui — eles vivem só no IndexedDB
   (js/db/), que já funciona offline nativamente.

   Estratégia:
   - Arquivos do app shell: "stale-while-revalidate" (responde do cache
     na hora, atualiza em segundo plano para a próxima visita).
   - Chamadas de rede que não são GET, ou que não são do mesmo domínio
     (ex: a API da IA usada pelo leitor de nota fiscal), passam direto
     e nunca são interceptadas nem guardadas em cache.

   Para publicar uma atualização do app: basta subir CACHE_VERSION.
   O service worker antigo é substituído e o cache velho, limpo,
   automaticamente na próxima abertura.
   ====================================================================== */

const CACHE_VERSION = 'martins-v4';

const ARQUIVOS_APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/core/utils.js',
  './js/core/dicionarioPecas.js',
  './js/db/database.js',
  './js/db/clientes.js',
  './js/db/veiculos.js',
  './js/db/pecas.js',
  './js/db/maoDeObra.js',
  './js/db/ordens.js',
  './js/db/orcamentos.js',
  './js/db/despesas.js',
  './js/db/configuracoes.js',
  './js/modules/clientes.js',
  './js/modules/ordens.js',
  './js/modules/orcamentos.js',
  './js/modules/financeiro.js',
  './js/modules/leitorNota.js',
  './js/modules/estoque.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(ARQUIVOS_APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes
          .filter((nome) => nome !== CACHE_VERSION)
          .map((nome) => caches.delete(nome))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Só intercepta GET do mesmo domínio (app shell). Chamadas à API de IA,
  // fontes do Google e qualquer POST/PUT seguem direto para a rede.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const respostaCache = await cache.match(request);

      const buscaRede = fetch(request)
        .then((respostaRede) => {
          if (respostaRede && respostaRede.status === 200) {
            cache.put(request, respostaRede.clone());
          }
          return respostaRede;
        })
        .catch(() => respostaCache);

      // Responde do cache na hora quando existir (rápido, funciona offline);
      // sempre atualiza o cache em segundo plano para a próxima visita.
      return respostaCache || buscaRede;
    })
  );
});
