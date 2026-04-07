/**
 * Zuwera Language Selector — lang.js
 * Uses Google Translate Element (free, no API key).
 * Language switching uses the `googtrans` cookie + page reload:
 *   - Switching to a language: set cookie `/en/LANG` → reload
 *   - Switching back to English: clear cookie → reload (zero translation credits)
 * This is the most reliable cross-browser approach and avoids
 * the "can't go back to English" bug with the combo select approach.
 */
(function () {
  'use strict';

  // ─── Language Registry ───────────────────────────────────────────────────────
  const LANGUAGES = [
    { code: 'en',    flag: '🇺🇸', native: 'English',            english: 'English' },
    { code: 'yo',    flag: '🇳🇬', native: 'Yorùbá',             english: 'Yoruba' },
    { code: 'ha',    flag: '🇳🇬', native: 'Hausa',              english: 'Hausa' },
    { code: 'sw',    flag: '🇰🇪', native: 'Kiswahili',          english: 'Swahili' },
    { code: 'ig',    flag: '🇳🇬', native: 'Igbo',               english: 'Igbo' },
    { code: 'am',    flag: '🇪🇹', native: 'አማርኛ',              english: 'Amharic' },
    { code: 'fr',    flag: '🇫🇷', native: 'Français',           english: 'French' },
    { code: 'it',    flag: '🇮🇹', native: 'Italiano',           english: 'Italian' },
    { code: 'ja',    flag: '🇯🇵', native: '日本語',             english: 'Japanese' },
    { code: 'ko',    flag: '🇰🇷', native: '한국어',             english: 'Korean' },
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

  // ─── Cookie Helpers ──────────────────────────────────────────────────────────
  // Google Translate reads the `googtrans` cookie to know which language to apply.
  // Format: `/en/fr`  (source/target). We always translate FROM English.

  function setGoogTransCookie(langCode) {
    const val = `/en/${langCode}`;
    const host = location.hostname;
    // Set for root path on both bare domain and dot-prefixed (covers subdomains)
    document.cookie = `googtrans=${val}; path=/`;
    document.cookie = `googtrans=${val}; path=/; domain=${host}`;
    if (host.indexOf('.') !== -1) {
      document.cookie = `googtrans=${val}; path=/; domain=.${host}`;
    }
  }

  function clearGoogTransCookie() {
    const past = 'expires=Thu, 01 Jan 1970 00:00:00 UTC';
    const host = location.hostname;
    document.cookie = `googtrans=; ${past}; path=/`;
    document.cookie = `googtrans=; ${past}; path=/; domain=${host}`;
    if (host.indexOf('.') !== -1) {
      document.cookie = `googtrans=; ${past}; path=/; domain=.${host}`;
    }
  }

  function readGoogTransCookie() {
    // Returns the target language code, or 'en' if no cookie / cookie is English
    const m = document.cookie.match(/(?:^|;\s*)googtrans=([^;]+)/);
    if (!m) return 'en';
    const parts = decodeURIComponent(m[1]).split('/'); // e.g. ['','en','fr']
    const target = parts[2] || 'en';
    return target === 'en' ? 'en' : target;
  }

  // ─── State ───────────────────────────────────────────────────────────────────
  // Derive current language from the cookie (source of truth).
  // localStorage is only used to show the chip without re-reading cookie on every render.
  let currentLang = readGoogTransCookie();
  // Keep localStorage in sync for chip display persistence
  if (currentLang !== 'en') {
    localStorage.setItem('zw_lang', currentLang);
  } else {
    localStorage.removeItem('zw_lang');
  }

  // ─── Suppress Google Translate Bar (must run BEFORE GT script) ───────────────
  // Injected immediately — before the GT element script can insert its bar.
  function injectGTHideStyles() {
    if (document.getElementById('zw-gt-hide')) return;
    const s = document.createElement('style');
    s.id = 'zw-gt-hide';
    s.textContent = `
      /* Hide every piece of the Google Translate UI */
      .goog-te-banner-frame,
      .goog-te-balloon-frame,
      #goog-gt-tt,
      .goog-tooltip,
      .goog-tooltip:hover,
      .goog-te-gadget,
      .goog-te-gadget img,
      .goog-logo-link,
      .skiptranslate { display: none !important; visibility: hidden !important; }
      /* Prevent GT from pushing the body down */
      body { top: 0 !important; }
      /* Hide the floating "X" restore bar that sometimes appears */
      iframe.goog-te-banner-frame { display: none !important; }
    `;
    // Insert as early as possible — at the start of <head>
    const head = document.head || document.documentElement;
    head.insertBefore(s, head.firstChild);
  }

  // Run immediately, synchronously — before anything else
  injectGTHideStyles();

  // Also re-suppress after GT loads (it sometimes re-inserts styles)
  function suppressGTBarRuntime() {
    // Force body top to 0
    document.body.style.setProperty('top', '0', 'important');
    // Hide any injected banner iframes
    document.querySelectorAll('.goog-te-banner-frame, .skiptranslate').forEach(el => {
      el.style.setProperty('display', 'none', 'important');
    });
  }

  // ─── Google Translate Bootstrap ──────────────────────────────────────────────
  // Only load the GT script when a non-English language is active.
  // For English pages, we skip it entirely — no API usage, no bar, no overhead.

  window.googleTranslateElementInit = function () {
    new window.google.translate.TranslateElement(
      {
        pageLanguage: 'en',
        autoDisplay: false,
        includedLanguages: LANGUAGES.map(l => l.code).join(','),
      },
      'zw-gt-element'
    );
    // GT is loaded — suppress its bar immediately and after a short delay
    suppressGTBarRuntime();
    setTimeout(suppressGTBarRuntime, 300);
    setTimeout(suppressGTBarRuntime, 1000);
  };

  function loadGTScript() {
    if (document.getElementById('zw-gt-script')) return;
    const s = document.createElement('script');
    s.id = 'zw-gt-script';
    s.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    s.async = true;
    document.head.appendChild(s);
  }

  // ─── Inject Hidden GT Element Div ────────────────────────────────────────────
  function injectGTElement() {
    if (document.getElementById('zw-gt-element')) return;
    const div = document.createElement('div');
    div.id = 'zw-gt-element';
    div.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;visibility:hidden;';
    div.setAttribute('aria-hidden', 'true');
    document.body.appendChild(div);
  }

  // ─── Language Selection ───────────────────────────────────────────────────────
  function selectLanguage(code) {
    if (code === currentLang) {
      closeModal();
      return;
    }

    if (code === 'en') {
      // ── Reset to English ──
      // Clear the googtrans cookie and reload. GT never runs. Zero credits used.
      clearGoogTransCookie();
      localStorage.removeItem('zw_lang');
      location.reload();
    } else {
      // ── Switch to another language ──
      // Set the googtrans cookie and reload. GT picks it up on load.
      setGoogTransCookie(code);
      localStorage.setItem('zw_lang', code);
      location.reload();
    }
    // (page reloads, so nothing below runs)
  }

  // ─── Footer Chip ─────────────────────────────────────────────────────────────
  function updateLangChip() {
    const lang = LANGUAGES.find(l => l.code === currentLang) || LANGUAGES[0];
    document.querySelectorAll('.zw-lang-chip').forEach(el => {
      el.textContent = `${lang.flag} ${lang.code.split('-')[0].toUpperCase()}`;
      el.setAttribute('translate', 'no');
    });
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
              transition:border-color 0.2s;box-sizing:border-box;">
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

    document.getElementById('zw-lang-close').addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.getElementById('zw-lang-reset').addEventListener('click', () => selectLanguage('en'));
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

  // ─── Inject Footer Button ─────────────────────────────────────────────────────
  function injectFooterButton() {
    const footer = document.querySelector('footer');
    if (!footer) return;
    if (footer.querySelector('.zw-lang-trigger')) return;

    const lang = LANGUAGES.find(l => l.code === currentLang) || LANGUAGES[0];
    const btn = document.createElement('button');
    btn.className = 'zw-lang-trigger notranslate';
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

  // ─── Inject Component Styles ──────────────────────────────────────────────────
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

    if (currentLang !== 'en') {
      // Non-English page: mount the hidden GT element and load the script
      // GT will read the googtrans cookie and apply translation automatically
      injectGTElement();
      loadGTScript();
    }
    // English page: skip GT entirely — no script, no bar, no credits

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
