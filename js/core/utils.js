/* ======================================================================
   MARTINS — Gestão de Oficina Mecânica
   core/utils.js — utilitários compartilhados de UI e formatação

   Antes da revisão, cada módulo de tela (clientes, ordens, orçamentos,
   estoque, financeiro, leitor de nota) reimplementava as mesmas funções
   de formatação, toast e modal — praticamente copia e cola. Este arquivo
   centraliza tudo isso num único lugar (`Utils`), carregado uma vez,
   antes de qualquer módulo de tela.

   Cada módulo continua podendo usar os mesmos nomes de sempre dentro
   do seu próprio arquivo, só que agora "puxados" do Utils:

     const { formatarMoeda, formatarData, escapeHtml, mostrarToast } = Utils;

   Isso elimina a duplicação sem exigir que nenhuma tela mude a forma
   como chama essas funções internamente.
   ====================================================================== */

const Utils = (() => {

  /* --------------------------------------------------------------------
     Formatação
     -------------------------------------------------------------------- */

  /** Remove tudo que não for dígito (usado em telefone, CPF, etc.). */
  function apenasDigitos(valor) {
    return (valor ?? '').toString().replace(/\D/g, '');
  }

  /** Formata um número como moeda brasileira (R$ 0,00). */
  function formatarMoeda(valor) {
    return (Number(valor) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  /** Formata uma data ISO como dd/mm/aaaa; retorna "—" quando vazia. */
  function formatarData(isoString) {
    if (!isoString) return '—';
    const data = new Date(isoString);
    if (Number.isNaN(data.getTime())) return '—';
    return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  /** Formata uma data ISO como dd/mm/aaaa às hh:mm. */
  function formatarDataHora(isoString) {
    if (!isoString) return '—';
    const data = new Date(isoString);
    if (Number.isNaN(data.getTime())) return '—';
    return `${data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })} às ${data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  }

  /** Escapa texto para inserção segura em innerHTML (evita XSS via dados salvos). */
  function escapeHtml(texto) {
    const div = document.createElement('div');
    div.textContent = texto ?? '';
    return div.innerHTML;
  }

  /** Atraso simples (debounce) para campos de busca e afins. */
  function debounce(fn, delayMs = 200) {
    let timeoutId = null;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delayMs);
    };
  }

  /* --------------------------------------------------------------------
     Toast (feedback de sucesso/erro), empilhável — vários toasts em
     sequência rápida não se sobrepõem, cada um aparece acima do anterior
     enquanto ainda estiver visível.
     -------------------------------------------------------------------- */
  function mostrarToast(mensagem, tipo = 'sucesso', duracaoMs = 2600) {
    const host = document.getElementById('toast-host') || (() => {
      const el = document.createElement('div');
      el.id = 'toast-host';
      el.className = 'toast-host';
      document.body.appendChild(el);
      return el;
    })();

    const toast = document.createElement('div');
    toast.className = `toast toast-${tipo}`;
    toast.textContent = mensagem;
    toast.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
    host.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('is-visible'));

    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 250);
    }, duracaoMs);
  }

  /* --------------------------------------------------------------------
     Modal (bottom sheet) — cria o esqueleto padrão (handle, título,
     botão de fechar, corpo, rodapé) reaproveitado por toda tela que
     precisa de formulário/detalhe/confirmação num único overlay.

     Fecha automaticamente ao tocar fora, no "x" ou na tecla Esc. Só
     remove a trava de scroll do body (`modal-aberto`) quando não houver
     nenhum outro modal aberto por baixo (ex: leitor de nota por cima do
     formulário de OS), evitando destravar o scroll cedo demais.
     -------------------------------------------------------------------- */
  function criarModal(overlayId) {
    const tituloId = `${overlayId}-titulo`;
    const corpoId = `${overlayId}-corpo`;
    const rodapeId = `${overlayId}-rodape`;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = overlayId;
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${tituloId}">
        <div class="modal-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <h2 class="modal-titulo" id="${tituloId}"></h2>
          <button type="button" class="modal-fechar" aria-label="Fechar">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <div class="modal-body" id="${corpoId}"></div>
        <div class="modal-footer" id="${rodapeId}"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const tituloEl = overlay.querySelector(`#${tituloId}`);
    const corpoEl = overlay.querySelector(`#${corpoId}`);
    const rodapeEl = overlay.querySelector(`#${rodapeId}`);

    function abrir(titulo) {
      tituloEl.textContent = titulo;
      overlay.classList.add('is-open');
      document.body.classList.add('modal-aberto');
    }

    function fechar() {
      overlay.classList.remove('is-open');
      corpoEl.innerHTML = '';
      rodapeEl.innerHTML = '';
      // Só destrava o scroll do body se não houver outro modal aberto
      // por baixo deste (ex: leitor de nota fiscal sobre o form de OS).
      const outroModalAberto = document.querySelector('.modal-overlay.is-open');
      if (!outroModalAberto) document.body.classList.remove('modal-aberto');
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) fechar();
    });
    overlay.querySelector('.modal-fechar').addEventListener('click', fechar);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('is-open')) fechar();
    });

    return {
      overlay,
      modalTitulo: tituloEl,
      modalCorpo: corpoEl,
      modalRodape: rodapeEl,
      abrir,
      fechar,
    };
  }

  /**
   * Permite ativar cards clicáveis (role="button") pelo teclado, com
   * Enter ou Espaço, sem duplicar a lógica de clique de cada tela: o
   * card simplesmente recebe um `.click()` nativo, que dispara o mesmo
   * listener de clique por delegação já existente na lista.
   *
   * @param {HTMLElement} container elemento pai onde os cards vivem (ex: els.lista)
   * @param {string} seletorCard seletor CSS do card (ex: '.cliente-card')
   */
  function ativarCardComTeclado(container, seletorCard) {
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest(seletorCard);
      if (!card) return;
      e.preventDefault();
      card.click();
    });
  }

  return {
    apenasDigitos,
    formatarMoeda,
    formatarData,
    formatarDataHora,
    escapeHtml,
    debounce,
    mostrarToast,
    criarModal,
    ativarCardComTeclado,
  };
})();
