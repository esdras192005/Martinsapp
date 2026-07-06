/* ======================================================================
   MARTINS — Gestão de Oficina Mecânica
   app.js — ponto de entrada e navegação

   Este arquivo cuida apenas da estrutura (shell) do app: trocar de
   view e manter o estado de qual item do menu está ativo.

   Cada nova funcionalidade (Ordens, Clientes, Estoque, Financeiro...)
   deve ganhar seu próprio arquivo em js/modules/, seguindo o padrão
   descrito no final deste arquivo, em vez de crescer dentro daqui.
   ====================================================================== */

const App = {

  // Nome das views precisa bater com o atributo data-view no HTML
  state: {
    currentView: 'inicio',
  },

  elements: {
    views: null,
    navItems: null,
  },

  async init() {
    this.elements.views = document.querySelectorAll('.view');
    this.elements.navItems = document.querySelectorAll('.nav-item');

    this.elements.navItems.forEach((item) => {
      item.addEventListener('click', () => this.navigateTo(item.dataset.view));
    });

    // Banco de dados local: precisa estar pronto antes dos módulos de feature
    try {
      await MartinsDB.init();
      await ConfiguracoesDB.seedPadrao();
    } catch (erro) {
      console.error('Falha ao iniciar o banco de dados local:', erro);
    }

    // Ponto de extensão: módulos de funcionalidade se registram aqui
    App.modules.init();

    this.registrarServiceWorker();
  },

  /**
   * Registra o service worker (cache do app shell + funcionamento offline).
   * Silenciosamente ignorado em navegadores sem suporte ou em ambientes
   * sem HTTPS/localhost (onde a API não fica disponível) — nunca impede
   * o app de funcionar.
   */
  registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch((erro) => {
        console.warn('Service worker não pôde ser registrado:', erro);
      });
    });
  },

  navigateTo(viewName) {
    if (viewName === this.state.currentView) return;

    this.elements.views.forEach((view) => {
      view.classList.toggle('is-active', view.dataset.view === viewName);
    });

    this.elements.navItems.forEach((item) => {
      item.classList.toggle('is-active', item.dataset.view === viewName);
    });

    this.state.currentView = viewName;

    // Avisa os módulos que a tela mudou, caso precisem carregar dados
    App.modules.onNavigate(viewName);
  },

  /* --------------------------------------------------------------------
     Registro de módulos de funcionalidade.

     Quando uma nova funcionalidade for criada (ex: Ordens de Serviço),
     crie js/modules/ordens.js com algo como:

       const OrdensModule = {
         name: 'ordens',
         init() { ... },        // roda uma vez, no carregamento do app
         onNavigate() { ... },  // roda toda vez que a view fica ativa
       };
       App.modules.register(OrdensModule);

     E adicione o <script src="js/modules/ordens.js" defer></script>
     no index.html, antes do app.js.
     -------------------------------------------------------------------- */
  modules: {
    registry: [],

    register(module) {
      this.registry.push(module);
    },

    init() {
      this.registry.forEach((module) => module.init && module.init());
    },

    onNavigate(viewName) {
      this.registry.forEach((module) => {
        if (module.name === viewName && module.onNavigate) {
          module.onNavigate();
        }
      });
    },
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
