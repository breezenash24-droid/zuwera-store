/**
 * Zuwera Language Selector — lang.js
 * Uses Google Translate Element (free, no API key) with a custom Zuwera-branded modal.
 * Attach to any page with: <script src="lang.js" defer></script>
 */
(function () {
  'use strict';

  // ─── Language Registry ───────────────────────────────────────────────────────
  // Languages curated for the Zuwera brand: fashion capitals + African roots +
  // global markets. Ordered by cultural relevance to the brand.
  const LANGUAGES = [
    // Default / English
    { code: 'en',    flag: '🇺🇸', native: 'English',            english: 'English' },

    // African roots — Zuwera's heritage
    { code: 'yo',    flag: '🇳🇬', native: 'Yorùbá',             english: 'Yoruba' },
    { code: 'ha',    flag: '🇳🇬', native: 'Hausa',              english: 'Hausa' },
    { code: 'sw',    flag: '🇰🇪', native: 'Kiswahili',          english: 'Swahili' },
    { code: 'ig',    flag: '🇳🇬', native: 'Igbo',               english: 'Igbo' },
    { code: 'am',    flag: '🇪🇹', native: 'አማርኛ',              english: 'Amharic' },
    { code: 'fr',    flag: '🇫🇷', native: 'Français',           english: 'French' },  // heavily spoken in West Africa

    // Fashion capitals
    { code: 'it',    flag: '🇮🇹', native: 'Italiano',           english: 'Italian' },
    { code: 'ja',    flag: '🇯🇵', native: '日本語',             english: 'Japanese' },
    { code: 'ko',    flag: '🇰🇷', native: '한국어',             english: 'Korean' },

    // Global markets
    { code: 'es',    flag: '🇪🇸', native: 'Español',            english: 'Spanish' },
    { code: 'pt',    flag: '🇧🇷', native: 'Português',          english: 'Portuguese' },
    { code: 'ar',    flag: '🇸🇦', native: 'العربية',            english: 'Arabic' },
    { code: 'de',    flag: '🇩🇪', native: 'Deutsch',            english: 'German' },
    { code: 'zh-CN', flag: '🇨🇳', native: '中文',               english: 'Chinese' },
    { code: 'hi',    flag: '🇮🇳', native: 'हिन्दी',            english: 'Hindi' },
    { code: 'ru',    flag: '🇷🇺', native: 'Русский',            english: 'Russian' },
    { code: 'tr',    flag: '🇹🇷', native: 'Türkçe',             english: 'Turkish' },
    { code: 'nl',    flag: '🇳🇱', native: 'Nederlands',         english: 'Dutch' },
    { code: 'sv',    flag: '🇸🇪', native: 'Svenska',            english: 'Swedish' },
    { code: 'id',    flag: '🇮🇩', native: 'Bahasa Indonesia',   english: 'Indonesian' },
  ];

  // ─── State ───────────────────────────────────────────────────────────────────
  let currentLang = localStorage.getItem('zw_lang') || 'en';
  let gtReady = false;
  let _pendingLang = null;

  // ─── Google Translate Bootstrap ──────────────────────────────────────────────
  window.googleTranslateElementInit = function () {
    new window.google.translate.TranslateElement(
      { pageLanguage: 'en', autoDisplay: false, includedLanguages: LANGUAGES.map(l => l.code).join(',') },
      'zw-gt-element'
    );
    gtReady = true;
    // Suppress Google Translate bar
    suppressGTBar();
    // Restore saved language — ensures it persists across page navigations
    // Google Translate uses a cookie, but we back it up with localStorage for reliability
    if (currentLang !== 'en') {
      setTimeout(() => applyGTLang(currentLang), 700);
    }
  };

  function loadGTScript() {
    if (document.getElementById('zw-gt-script')) return;
    const s = document.createElement('script');
    s.id = 'zw-gt-script';
    s.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    s.async = true;
    document.head.appendChild(s);
  }

  function suppressGTBar() {
    // Inject CSS to hide Google Translate's toolbar
    if (document.getElementById('zw-gt-hide')) return;
    const style = document.createElement('style');
    style.id = 'zw-gt-hide';
    style.textContent = `
      .goog-te-banner-frame, .goog-te-balloon-frame,
      #goog-gt-tt, .goog-te-balloon-frame,
      .goog-tooltip, .goog-tooltip:hover { display: none !important; }
      .goog-te-gadget { display: none !important; }
      .goog-te-gadget img { display: none !important; }
      .goog-logo-link { display: none !important; }
      body { top: 0 !important; }
      .skiptranslate { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  function applyGTLang(code) {
    if (code === 'en') {
      // Restore to English — reset the widget
      const iframe = document.querySelector('.goog-te-menu-frame');
      if (iframe) iframe.style.display = 'none';
      // Use the select combo to restore
      const combo = document.querySelector('select.goog-te-combo');
      if (combo) {
        combo.value = '';
        combo.dispatchEvent(new Event('change'));
      } else {
        // Fallback: reload without hash
        const url = window.location.href.replace(/#googtrans\([^)]*\)/g, '');
        if (window.location.href !== url) window.location.href = url;
      }
    } else {
      const combo = document.querySelector('select.goog-te-combo');
      if (combo) {
        combo.value = code;
        combo.dispatchEvent(new Event('change'));
      }
    }
  }

  // ─── Inject Hidden GT Element ─────────────────────────────────────────────────
  function injectGTElement() {
    if (document.getElementById('zw-gt-element')) return;
    const div = document.createElement('div');
    div.id = 'zw-gt-element';
    div.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;';
    div.setAttribute('aria-hidden', 'true');
    document.body.appendChild(div);
  }

  // ─── Modal HTML ───────────────────────────────────────────────────────────────
  function buildModal() {
    if (document.getElementById('zw-lang-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'zw-lang-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Select language');
    modal.style.cssText = `
      display:none; position:fixed; inset:0; z-index:100000;
      background:rgba(0,0,0,0.72); backdrop-filter:blur(8px);
      align-items:center; justify-content:center; padding:1rem;
    `;

    modal.innerHTML = `
      <div id="zw-lang-box" class="notranslate" translate="no" style="
        background:#0f0f12; border:1px solid rgba(244,241,235,0.1);
        border-radius:12px; width:100%; max-width:620px;
        max-height:88dvh; overflow:hidden; display:flex; flex-direction:column;
        box-shadow:0 24px 64px rgba(0,0,0,0.7);
      ">
        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;
             padding:1.4rem 1.6rem 1rem; border-bottom:1px solid rgba(244,241,235,0.07); flex-shrink:0;">
          <div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:0.1em;color:#f4f1eb;">
              Choose Language
            </div>
            <div style="font-size:0.72rem;color:rgba(244,241,235,0.4);letter-spacing:0.08em;text-transform:uppercase;margin-top:2px;">
              Select your preferred language
            </div>
          </div>
          <button id="zw-lang-close" aria-label="Close language selector" style="
            width:34px;height:34px;display:flex;align-items:center;justify-content:center;
            background:rgba(244,241,235,0.05);border:1px solid rgba(244,241,235,0.08);
            color:#f4f1eb;font-size:1.1rem;cursor:pointer;border-radius:6px;flex-shrink:0;
          ">&#215;</button>
        </div>

        <!-- Search -->
        <div style="padding:0.9rem 1.6rem 0.5rem; flex-shrink:0;">
          <div style="position:relative;">
            <svg style="position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:0.3;"
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
            <input id="zw-lang-search" type="text" placeholder="Search language..."
              autocomplete="off" spellcheck="false"
              style="width:100%;background:rgba(244,241,235,0.05);border:1px solid rgba(244,241,235,0.1);
              color:#f4f1eb;border-radius:6px;padding:0.55rem 0.75rem 0.55rem 2rem;
              font-size:0.82rem;font-family:'DM Sans',sans-serif;outline:none;
              transition:border-color 0.2s;">
          </div>
        </div>

        <!-- Language Grid -->
        <div id="zw-lang-grid" style="
          padding:0.5rem 1.2rem 1.4rem; overflow-y:auto; flex:1;
          display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:0.5rem;
        "></div>

        <!-- Footer -->
        <div style="padding:0.8rem 1.6rem;border-top:1px solid rgba(244,241,235,0.07);
             flex-shrink:0;display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:0.65rem;color:rgba(244,241,235,0.2);letter-spacing:0.06em;text-transform:uppercase;">
            Powered by Google Translate
          </span>
          <button id="zw-lang-reset" style="
            font-size:0.68rem;color:rgba(244,241,235,0.35);background:none;border:none;
            cursor:pointer;letter-spacing:0.06em;text-transform:uppercase;padding:0;
            font-family:'DM Sans',sans-serif; transition:color 0.2s;
          " onmouseenter="this.style.color='#F891A5'" onmouseleave="this.style.color='rgba(244,241,235,0.35)'">
            Reset to English
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event listeners
    document.getElementById('zw-lang-close').addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.getElementById('zw-lang-reset').addEventListener('click', () => {
      selectLanguage('en');
      closeModal();
    });
    document.getElementById('zw-lang-search').addEventListener('input', e => {
      renderGrid(e.target.value.toLowerCase());
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
    });

    renderGrid();
  }

  function renderGrid(filter = '') {
    const grid = document.getElementById('zw-lang-grid');
    if (!grid) return;
    const visible = filter
      ? LANGUAGES.filter(l =>
          l.native.toLowerCase().includes(filter) ||
          l.english.toLowerCase().includes(filter) ||
          l.code.toLowerCase().includes(filter)
        )
      : LANGUAGES;

    grid.innerHTML = visible.map(lang => {
      const active = lang.code === currentLang;
      return `
        <button onclick="zwLang.select('${lang.code}')" data-code="${lang.code}" style="
          display:flex;align-items:center;gap:0.6rem;
          background:${active ? 'rgba(248,145,165,0.12)' : 'rgba(244,241,235,0.03)'};
          border:1px solid ${active ? '#F891A5' : 'rgba(244,241,235,0.07)'};
          border-radius:8px;padding:0.65rem 0.85rem;cursor:pointer;
          text-align:left;width:100%;transition:background 0.15s,border-color 0.15s;
          color:#f4f1eb;
        "
        onmouseenter="if(this.dataset.code!=='${currentLang}'){this.style.background='rgba(244,241,235,0.07)';this.style.borderColor='rgba(244,241,235,0.15)';}"
        onmouseleave="if(this.dataset.code!=='${currentLang}'){this.style.background='rgba(244,241,235,0.03)';this.style.borderColor='rgba(244,241,235,0.07)';}">
          <span style="font-size:1.4rem;line-height:1;flex-shrink:0;">${lang.flag}</span>
          <div style="min-width:0;">
            <div style="font-size:0.82rem;font-weight:500;font-family:'DM Sans',sans-serif;
                 white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                 color:${active ? '#F891A5' : '#f4f1eb'};">${lang.native}</div>
            <div style="font-size:0.65rem;color:rgba(244,241,235,0.35);font-family:'DM Sans',sans-serif;
                 letter-spacing:0.04em;">${lang.english}</div>
          </div>
          ${active ? `<svg style="margin-left:auto;flex-shrink:0;" width="12" height="12" viewBox="0 0 24 24"
               fill="none" stroke="#F891A5" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
        </button>
      `;
    }).join('');
  }

  // ─── Open / Close ─────────────────────────────────────────────────────────────
  function openModal() {
    buildModal();
    const modal = document.getElementById('zw-lang-modal');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      const search = document.getElementById('zw-lang-search');
      if (search) { search.value = ''; renderGrid(); search.focus(); }
    }, 50);
  }

  function closeModal() {
    const modal = document.getElementById('zw-lang-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  // ─── Language Selection ───────────────────────────────────────────────────────
  function selectLanguage(code) {
    currentLang = code;
    localStorage.setItem('zw_lang', code);

    // Update footer chip
    updateLangChip();

    // Apply translation
    if (gtReady) {
      applyGTLang(code);
    } else {
      _pendingLang = code;
    }

    // Close modal
    closeModal();
    renderGrid();
  }

  function updateLangChip() {
    const lang = LANGUAGES.find(l => l.code === currentLang);
    document.querySelectorAll('.zw-lang-chip').forEach(el => {
      el.textContent = lang ? `${lang.flag} ${lang.code.split('-')[0].toUpperCase()}` : '🌐 EN';
      el.setAttribute('translate', 'no');
    });
  }

  // ─── Inject Footer Button ─────────────────────────────────────────────────────
  function injectFooterButton() {
    // Find the footer (multiple possible structures)
    const footer = document.querySelector('footer');
    if (!footer) return;

    // Check if already injected
    if (footer.querySelector('.zw-lang-trigger')) return;

    const lang = LANGUAGES.find(l => l.code === currentLang) || LANGUAGES[0];
    const btn = document.createElement('button');
    btn.className = 'zw-lang-trigger notranslate';
    // notranslate class + translate="no" ensure the button label is ALWAYS in English
    // so users who accidentally switch language can always find the button to switch back
    btn.setAttribute('translate', 'no');
    btn.setAttribute('aria-label', 'Change language');
    btn.setAttribute('title', 'Change language');
    btn.onclick = openModal;
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
      <span class="zw-lang-chip notranslate" translate="no">${lang.flag} ${lang.code.split('-')[0].toUpperCase()}</span>
      <span class="notranslate" translate="no" style="opacity:0.6;">Language</span>
    `;
    footer.appendChild(btn);
  }

  // ─── Inject Styles ────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('zw-lang-styles')) return;
    const style = document.createElement('style');
    style.id = 'zw-lang-styles';
    style.textContent = `
      .zw-lang-trigger {
        display: inline-flex; align-items: center; gap: 0.4rem;
        background: none; border: 1px solid rgba(244,241,235,0.12);
        color: rgba(244,241,235,0.35); border-radius: 20px;
        padding: 0.35rem 0.75rem; font-size: 0.65rem;
        font-family: 'DM Sans', sans-serif; letter-spacing: 0.08em;
        text-transform: uppercase; cursor: pointer;
        transition: color 0.2s, border-color 0.2s, background 0.2s;
        margin-top: 0.75rem;
      }
      .zw-lang-trigger:hover {
        color: #F891A5; border-color: rgba(248,145,165,0.35);
        background: rgba(248,145,165,0.06);
      }
      .zw-lang-chip { letter-spacing: 0.06em; }
      #zw-lang-search:focus { border-color: rgba(248,145,165,0.4) !important; }
      #zw-lang-grid::-webkit-scrollbar { width: 4px; }
      #zw-lang-grid::-webkit-scrollbar-track { background: transparent; }
      #zw-lang-grid::-webkit-scrollbar-thumb { background: rgba(244,241,235,0.1); border-radius: 2px; }
      @media (max-width: 600px) {
        #zw-lang-box { max-height: 92dvh; border-radius: 16px 16px 0 0; }
        #zw-lang-modal { align-items: flex-end !important; }
        #zw-lang-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    injectGTElement();
    loadGTScript();
    injectFooterButton();
    updateLangChip();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  window.zwLang = {
    open: openModal,
    close: closeModal,
    select: selectLanguage,
    languages: LANGUAGES,
    current: () => currentLang,
  };

})();
