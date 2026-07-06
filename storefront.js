// storefront.js
// Extracted inline JavaScript for Zuwera storefront (index.html).
// Sections: theme-sync IIFE, normalizeHomepageCopy IIFE, main app block, cookie banner, modal backdrop enforcer.

// Load theme immediately to prevent flash.
(function() {
  function syncThemeColor() {
    var isSuperLight = document.body.classList.contains('super-light-mode');
    var isLight = document.body.classList.contains('light-mode');
    var navBg = isSuperLight ? '#FFFFFF' : isLight ? '#F0EEE9' : '#09090b';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', navBg);
    document.documentElement.style.backgroundColor = navBg;
  }
  try {
    var _m = localStorage.getItem('zw_homepage_theme_mode') || localStorage.getItem('zw_theme_mode');
    if (_m === 'light') {
      document.body.classList.add('light-mode');
    } else if (_m === 'super-light') {
      document.body.classList.add('light-mode', 'super-light-mode');
    }
  } catch(_) {}
  syncThemeColor();
  window.__zwSyncThemeColor = syncThemeColor;
})();

// Product-card CTA mode (Add-to-Bag button vs Nike-style color swatches).
// Toggles body.zw-cards-swatches; CSS in storefront-cohesion.css swaps the card UI.
// Apply the cached value immediately (flash-free), then loadSiteSettings refreshes it.
window.__zwApplyCardMode = function (mode) {
  var on = mode === 'color-swatches';
  function set() { if (document.body) document.body.classList.toggle('zw-cards-swatches', on); }
  set();
  if (!document.body) document.addEventListener('DOMContentLoaded', set);
  try { localStorage.setItem('zw_card_cta', on ? 'color-swatches' : 'add-to-bag'); } catch (_) {}
};
(function () {
  try { window.__zwApplyCardMode(localStorage.getItem('zw_card_cta') || 'add-to-bag'); } catch (_) {}
})();

(function normalizeHomepageCopy() {
  const heroYear = document.querySelector('.hero-year');
  if (heroYear) heroYear.innerHTML = 'Zuwera &middot; Est. 2026';

  const aboutLead = document.querySelector('.about-body p');
  if (aboutLead) {
    aboutLead.textContent = 'Bold, athletic, and designed for those who dream big. Zuwera is sportswear built for the relentless - those who push past limits and never stop.';
  }

  const notifySuccess = document.getElementById('home-notify-success');
  if (notifySuccess) notifySuccess.innerHTML = '&#10003; You\'re on the list.';

  const releaseHeading = document.querySelector('.products-section .sec-head h2');
  if (releaseHeading) releaseHeading.textContent = 'Release 001';

  const footerCopy = document.querySelector('.fcopy');
  if (footerCopy) footerCopy.innerHTML = '&copy; 2026 Zuwera. All rights reserved.';
})();

console.log('[ZUWERA] build: 2026-05-25-v1 | full-page checkout');
/* TOAST */
let _toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  clearTimeout(_toastTimer);
  t.classList.add('on');
  _toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

/* â”€â”€ PAGE BUILDER PREVIEW LISTENER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   When opened inside /builder.html, receives postMessage with section
   config and applies it live without a Supabase round-trip.         */
(function() {
  // Expose applyBuilderConfig globally so it can be called by loadSiteSettings
  window.__zwApplyBuilderConfig = applyBuilderConfig;

  // Inject preview-only styles dynamically when needed
  let stylesInjected = false;
  function injectBuilderStyles() {
    if (stylesInjected) return;
    const style = document.createElement('style');
    style.textContent = `
      body.builder-preview .products-section {
        background: var(--ink);
      }
    `;
    document.head.appendChild(style);
    stylesInjected = true;
  }
  const _FONT_STACKS = {
    'barlow-condensed':"'Barlow Condensed',sans-serif",
    'oswald':"'Oswald',sans-serif",
    'bebas-neue':"'Bebas Neue',sans-serif",
    'anton':"'Anton',sans-serif",
    'league-gothic':"'League Gothic',sans-serif",
    'michroma':"'Michroma',sans-serif",
    'montserrat':"'Montserrat',sans-serif",
    'syne':"'Syne',sans-serif",
    'archivo-black':"'Archivo Black',sans-serif",
    'teko':"'Teko',sans-serif",
    'righteous':"'Righteous',display",
    'playfair-display':"'Playfair Display',serif",
    'cinzel':"'Cinzel',serif",
    'futura':'"Futura", "Jost", sans-serif',
    'futura-100-bold':'"Futura 100 Bold", "Futura", "Jost", sans-serif',
    'futura-100-bold-oblique':'"Futura 100 Bold Oblique", "Futura", "Jost", sans-serif',
    'barlow':"'Barlow',sans-serif",
    'inter':"'Inter',sans-serif",
    'dm-sans':"'DM Sans',sans-serif",
    'outfit':"'Outfit',sans-serif",
    'manrope':"'Manrope',sans-serif",
    'poppins':"'Poppins',sans-serif",
    'lato':"'Lato',sans-serif",
    'roboto':"'Roboto',sans-serif",
    'work-sans':"'Work Sans',sans-serif",
    'mulish':"'Mulish',sans-serif"
  };
  const _FONT_URLS = {
    'oswald':'https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap',
    'bebas-neue':'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
    'anton':'https://fonts.googleapis.com/css2?family=Anton&display=swap',
    'league-gothic':'https://fonts.googleapis.com/css2?family=League+Gothic&display=swap',
    'michroma':'https://fonts.googleapis.com/css2?family=Michroma&display=swap',
    'montserrat':'https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,700;0,800;0,900;1,700;1,800;1,900&display=swap',
    'syne':'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&display=swap',
    'archivo-black':'https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap',
    'teko':'https://fonts.googleapis.com/css2?family=Teko:wght@600;700&display=swap',
    'righteous':'https://fonts.googleapis.com/css2?family=Righteous&display=swap',
    'playfair-display':'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;0,900;1,700;1,800;1,900&display=swap',
    'cinzel':'https://fonts.googleapis.com/css2?family=Cinzel:wght@700;800;900&display=swap',
    'futura':'https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,600;1,700&display=swap',
    'futura-100-bold':'https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,600;1,700&display=swap',
    'futura-100-bold-oblique':'https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,600;1,700&display=swap',
    'inter':'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
    'dm-sans':'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap',
    'outfit':'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
    'manrope':'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap',
    'poppins':'https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap',
    'lato':'https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,300;0,400;0,700;1,400&display=swap',
    'roboto':'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;1,400&display=swap',
    'work-sans':'https://fonts.googleapis.com/css2?family=Work+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap',
    'mulish':'https://fonts.googleapis.com/css2?family=Mulish:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap'
  };

  function _loadBuilderFont(key) {
    if (!key || !_FONT_URLS[key]) return;
    const id = 'gf-' + key;
    if (document.getElementById(id)) return;
    const l = document.createElement('link');
    l.id = id; l.rel = 'preload'; l.as = 'style';
    l.href = _FONT_URLS[key];
    l.onload = function(){ this.onload = null; this.rel = 'stylesheet'; };
    document.head.appendChild(l);
  }

  function applyBuilderConfig(cfg) {
    if (!cfg || !cfg.sections) return;

    injectBuilderStyles();

    // Apply SEO & Metadata dynamically
    if (cfg.seoSettings) {
      if (cfg.seoSettings.title) {
        document.title = cfg.seoSettings.title;
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) ogTitle.content = cfg.seoSettings.title;
        const twTitle = document.querySelector('meta[name="twitter:title"]');
        if (twTitle) twTitle.content = cfg.seoSettings.title;
      }
      if (cfg.seoSettings.description) {
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) metaDesc.content = cfg.seoSettings.description;
        const ogDesc = document.querySelector('meta[property="og:description"]');
        if (ogDesc) ogDesc.content = cfg.seoSettings.description;
        const twDesc = document.querySelector('meta[name="twitter:description"]');
        if (twDesc) twDesc.content = cfg.seoSettings.description;
      }
      if (cfg.seoSettings.image) {
        const ogImage = document.querySelector('meta[property="og:image"]');
        if (ogImage) ogImage.content = cfg.seoSettings.image;
        const twImage = document.querySelector('meta[name="twitter:image"]');
        if (twImage) twImage.content = cfg.seoSettings.image;
      }
    }

    // Apply theme
    if (cfg.theme === 'light') {
      document.body.classList.add('light-mode');
      document.body.classList.remove('super-light-mode');
    } else if (cfg.theme === 'super-light') {
      document.body.classList.add('light-mode','super-light-mode');
    } else {
      document.body.classList.remove('light-mode','super-light-mode');
    }

    // Apply navigation settings
    if (cfg.navSettings) {
      const logoImg = document.querySelector('.nav-logo img');
      if (logoImg && cfg.navSettings.logo_url) {
        logoImg.src = cfg.navSettings.logo_url;
        logoImg.srcset = cfg.navSettings.logo_url;
      }
      // Navigation links are owned by nav-menu.js (reads site_settings.nav_menu —
      // e.g. Men / Women / New). The legacy navSettings.links rendering was removed
      // because it raced with and overwrote the mobile menu, showing product
      // categories (Jackets, T-Shirts…) instead of the configured nav.
    }

    // Apply builder theme settings (bar bg/color, accent, etc.)
    if (cfg.themeSettings) {
      const bar = document.getElementById('bar');
      if (bar) {
        if (cfg.themeSettings.bar_bg) bar.style.setProperty('background', cfg.themeSettings.bar_bg, 'important');
        if (cfg.themeSettings.bar_text_color) bar.style.setProperty('color', cfg.themeSettings.bar_text_color, 'important');
      }
      if (cfg.themeSettings.accent_color) {
        document.documentElement.style.setProperty('--gold', cfg.themeSettings.accent_color);
        document.documentElement.style.setProperty('--zw-accent', cfg.themeSettings.accent_color);
      }
      if (cfg.themeSettings.button_radius) {
        const radiusMap = { sharp: '0px', soft: '4px', pill: '999px' };
        const radius = radiusMap[cfg.themeSettings.button_radius] || '0px';
        document.documentElement.style.setProperty('--zw-radius-control', radius);
      }
      // Brand colors
      if (cfg.themeSettings.primary_color) {
        document.documentElement.style.setProperty('--paper', cfg.themeSettings.primary_color);
        document.documentElement.style.setProperty('--white', cfg.themeSettings.primary_color);
      }
      if (cfg.themeSettings.page_bg) {
        document.documentElement.style.setProperty('--ink', cfg.themeSettings.page_bg);
        document.documentElement.style.setProperty('--black', cfg.themeSettings.page_bg);
        document.documentElement.style.setProperty('--bg', cfg.themeSettings.page_bg);
        document.body.style.setProperty('background', cfg.themeSettings.page_bg);
      }
      if (cfg.themeSettings.surface_color) {
        document.documentElement.style.setProperty('--zw-paper', cfg.themeSettings.surface_color);
      }

      if (cfg.themeSettings.heading_font) {
        const stack = _FONT_STACKS[cfg.themeSettings.heading_font];
        if (stack) {
          document.documentElement.style.setProperty('--fw', stack);
          document.documentElement.style.setProperty('--zw-font-head', stack);
        }
        _loadBuilderFont(cfg.themeSettings.heading_font);
      }
      if (cfg.themeSettings.body_font) {
        const stack = _FONT_STACKS[cfg.themeSettings.body_font];
        if (stack) {
          document.documentElement.style.setProperty('--fb', stack);
          document.documentElement.style.setProperty('--zw-font-body', stack);
        }
        _loadBuilderFont(cfg.themeSettings.body_font);
      }
      if (cfg.themeSettings.heading_weight) {
        document.documentElement.style.setProperty('--zw-fw-head', cfg.themeSettings.heading_weight);
      } else {
        document.documentElement.style.setProperty('--zw-fw-head', '900');
      }
      if (cfg.themeSettings.heading_style) {
        document.documentElement.style.setProperty('--zw-fst-head', cfg.themeSettings.heading_style);
        document.querySelectorAll('.hero-h1, .about-h2').forEach(el => el.style.fontStyle = cfg.themeSettings.heading_style);
      } else {
        document.documentElement.style.setProperty('--zw-fst-head', 'italic');
      }
      if (cfg.themeSettings.content_width) {
        document.documentElement.style.setProperty('--zw-max-w', cfg.themeSettings.content_width + 'px');
      }
      // Section spacing
      const _SPACING = { sm:'3rem', md:'5rem', lg:'7rem', xl:'10rem' };
      if (cfg.themeSettings.section_spacing && _SPACING[cfg.themeSettings.section_spacing]) {
        document.documentElement.style.setProperty('--zw-sec-pad', _SPACING[cfg.themeSettings.section_spacing]);
      }
      // Apply custom CSS
      let customCssEl = document.getElementById('zw-custom-css');
      if (cfg.themeSettings.custom_css) {
        if (!customCssEl) {
          customCssEl = document.createElement('style');
          customCssEl.id = 'zw-custom-css';
          document.head.appendChild(customCssEl);
        }
        customCssEl.textContent = cfg.themeSettings.custom_css;
      } else if (customCssEl) {
        customCssEl.remove();
      }
    }

    if (window.__ZW_BUILDER_PREVIEW__) {
      document.body.classList.add('builder-preview');
    } else {
      document.body.classList.remove('builder-preview');
    }
    const footer = document.querySelector('footer');

    // Un-nest products-section from drop-wrap so they can be reordered independently
    const dropWrap = document.querySelector('.drop-wrap');
    const productsSec = document.querySelector('.products-section');
    if (dropWrap && productsSec && dropWrap.contains(productsSec)) {
      dropWrap.parentNode.insertBefore(productsSec, dropWrap.nextSibling);
    }

    const sorted = [...cfg.sections].sort((a,b)=>(a.order||0)-(b.order||0));

    // Section visibility & order on the DOM
    const sectionMap = {
      hero:    document.querySelector('.hero'),
      marquee: document.querySelector('.marquee'),
      about:   document.querySelector('.section-about'),
      release: document.querySelector('.drop-wrap'),
      products:document.querySelector('.products-section')
    };

    // Hide all default sections first
    Object.values(sectionMap).forEach(el => {
      if (el) el.style.display = 'none';
    });
    // Hide all previously added dynamic builder sections
    document.querySelectorAll('.builder-spacer, .builder-text-section, .builder-image-cta-section, .builder-custom-section').forEach(el => {
      el.style.display = 'none';
    });

    sorted.forEach((sec, idx) => {
      let el = sectionMap[sec.type] || document.getElementById(sec.id);
      
      if (!el) {
        // Dynamically instantiate builder sections if they don't exist
        if (['spacer', 'text', 'img_cta', 'image_cta', 'custom', 'html',
             'numbers', 'press', 'faq', 'email_capture', 'logos', 'richtext',
             'split', 'cta', 'features', 'testimonials', 'banner', 'gallery', 'video', 'countdown', 'hero_carousel', 'media_grid'].includes(sec.type)) {
          el = document.createElement('div');
          el.id = sec.id;
          if (sec.type === 'spacer') {
            el.className = 'builder-spacer';
          } else if (sec.type === 'text') {
            el.className = 'builder-text-section';
            el.style.cssText = 'padding:6rem 2.5rem;max-width:800px;margin:0 auto;text-align:center';
            el.innerHTML = `
              <h2 data-builder-heading style="font-family:var(--fw);font-size:2.2rem;text-transform:uppercase;margin-bottom:1.5rem;letter-spacing:.08em;font-weight:900;font-style:italic"></h2>
              <p data-builder-body style="font-family:var(--fb);font-size:1.05rem;color:inherit;opacity:.75;line-height:1.75;margin-bottom:2rem;white-space:pre-line"></p>
              <a data-builder-cta class="btn-outline" style="display:inline-block;padding:.65rem 1.6rem;border:1px solid currentColor;font-family:var(--fm);font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;transition:all .2s"></a>
            `;
          } else if (sec.type === 'img_cta' || sec.type === 'image_cta') {
            el.className = 'builder-image-cta-section';
            el.style.cssText = 'position:relative;width:100%;min-height:420px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#09090b';
            el.innerHTML = `
              <img data-builder-img src="" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;opacity:.35">
              <div style="position:relative;z-index:2;text-align:center;padding:2rem">
                <a data-builder-btn class="btn-outline" style="display:inline-block;padding:.8rem 2rem;border:1px solid currentColor;font-family:var(--fm);font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;background:rgba(9,9,11,.65);backdrop-filter:blur(8px);transition:all .2s"></a>
              </div>
            `;
          } else if (sec.type === 'custom' || sec.type === 'html') {
            el.className = 'builder-custom-section';
          } else if (['numbers','press','faq','email_capture','logos','richtext',
                      'split','cta','features','testimonials','banner','gallery','video','countdown','hero_carousel','media_grid'].includes(sec.type)) {
            el.className = 'builder-' + sec.type.replace(/_/g,'-') + '-section';
          }
        }
      }

      if (!el) return;
      el.style.display = sec.visible ? '' : 'none';

      // Physically move the element in the DOM to enforce the correct order
      if (footer) {
        document.body.insertBefore(el, footer);
      } else {
        document.body.appendChild(el);
      }

      const secDataStr = JSON.stringify(sec);
      if (el._zwSecJSON === secDataStr) return;
      el._zwSecJSON = secDataStr;

      const s = sec.settings || {};

      // Style overrides moved to the bottom of the function so they don't get erased by cssText
      if (s.anchor_id) el.id = s.anchor_id;
      if (s.hide_mobile) {
        let mobileHideStyle = document.getElementById('zw-builder-mobile-hide-' + el.id);
        if (!mobileHideStyle) {
          mobileHideStyle = document.createElement('style');
          mobileHideStyle.id = 'zw-builder-mobile-hide-' + (s.anchor_id || sec.id);
          document.head.appendChild(mobileHideStyle);
        }
        mobileHideStyle.textContent = `@media(max-width:900px){#${s.anchor_id || sec.id}{display:none!important;}}`;
      }
      if (s.hide_desktop) {
        let desktopHideStyle = document.getElementById('zw-builder-desktop-hide-' + el.id);
        if (!desktopHideStyle) {
          desktopHideStyle = document.createElement('style');
          desktopHideStyle.id = 'zw-builder-desktop-hide-' + (s.anchor_id || sec.id);
          document.head.appendChild(desktopHideStyle);
        }
        desktopHideStyle.textContent = `@media(min-width:901px){#${s.anchor_id || sec.id}{display:none!important;}}`;
      }
      switch(sec.type) {
        case 'hero': {
          const h1 = el.querySelector('.hero-h1');
          const sub = el.querySelector('.hero-sub');
          const kicker = el.querySelector('.hero-kicker');
          const ctaPrimary = el.querySelector('.hero-cta-row .btn-outline');
          const ctaSecondary = el.querySelector('.hero-cta-row .btn-ghost');
          if (h1 && s.heading !== undefined) h1.innerHTML = (s.heading || '').replace(/\n/g,'<br>');
          if (sub && s.subtext !== undefined) sub.textContent = s.subtext || '';
          if (kicker && s.kicker !== undefined) kicker.textContent = s.kicker || '';
          
          const primaryText = s.cta1_text || s.cta_primary_text;
          const primaryUrl = s.cta1_url || s.cta_primary_url;
          if (ctaPrimary && primaryText !== undefined) {
            const svg = ctaPrimary.querySelector('svg');
            ctaPrimary.textContent = primaryText;
            if (svg) ctaPrimary.appendChild(svg);
          }
          if (ctaPrimary && primaryUrl) ctaPrimary.onclick = () => { if(primaryUrl.startsWith('#')) document.getElementById(primaryUrl.slice(1))?.scrollIntoView({behavior:'smooth'}); else location.href=zwSafeUrl(primaryUrl); };
          
          const secondaryVisible = s.cta2_on !== undefined ? s.cta2_on : s.cta_secondary_visible;
          const secondaryText = s.cta2_text || s.cta_secondary_text;
          const secondaryUrl = s.cta2_url || s.cta_secondary_url;
          if (ctaSecondary) ctaSecondary.style.display = secondaryVisible ? '' : 'none';
          if (ctaSecondary && secondaryText !== undefined) ctaSecondary.textContent = secondaryText;
          if (ctaSecondary && secondaryUrl) ctaSecondary.onclick = () => { if(secondaryUrl.startsWith('#')) document.getElementById(secondaryUrl.slice(1))?.scrollIntoView({behavior:'smooth'}); else location.href=zwSafeUrl(secondaryUrl); };
          
          // Image CTA overlay
          let imgCta = el.querySelector('.hero-img-cta');
          const imgCtaVisible = s.img_btn_on !== undefined ? s.img_btn_on : s.image_cta_visible;
          const imgCtaText = s.img_btn_text || s.image_cta_text;
          const imgCtaUrl = s.img_btn_url || s.image_cta_url;
          if (imgCtaVisible) {
            if (!imgCta) {
              imgCta = document.createElement('a');
              imgCta.className = 'hero-img-cta';
              imgCta.style.cssText = 'position:absolute;bottom:30%;left:50%;transform:translateX(-50%);z-index:10;padding:.65rem 1.8rem;background:rgba(255,255,255,.92);color:#09090b;font-family:var(--fm);font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;text-decoration:none;backdrop-filter:blur(8px);transition:opacity .2s';
              el.querySelector('.hero-img-wrap')?.appendChild(imgCta);
            }
            imgCta.textContent = imgCtaText || 'Shop Now';
            imgCta.href = imgCtaUrl || '/drop001.html';
            imgCta.style.display = '';
          } else if (imgCta) imgCta.style.display = 'none';
          // Background image
          const img = el.querySelector('#hero-image');
          const mobileSource = el.querySelector('#hero-mobile-source');
          if (s.image) {
            if (img) img.src = typeof window.optimizeImage === 'function' ? window.optimizeImage(s.image, 1400) : s.image;
            if (mobileSource) mobileSource.srcset = typeof window.optimizeImage === 'function' ? window.optimizeImage(s.image, 800) : s.image;
          } else {
            if (img) img.src = 'images/hero.jpg?v=2';
            if (mobileSource) mobileSource.srcset = 'images/hero-mobile.jpg';
          }
          // Fill (cover) vs Fit (contain) — lets a logo/graphic show whole.
          if (img) img.style.objectFit = (s.fit === 'contain') ? 'contain' : 'cover';
          break;
        }
        case 'marquee': {
          const track = el.querySelector('.marquee-track');
          if (track && s.items !== undefined) {
            const items = (s.items || '').split(',').map(i=>i.trim()).filter(Boolean);
            track.innerHTML = (items.concat(items)).map(i=>`<span class="marquee-item">${i}</span><span class="marquee-item accent">&#10022;</span>`).join('');
          }
          break;
        }
        case 'about': {
          const lbl = el.querySelector('.about-label');
          const h2 = el.querySelector('.about-h2');
          const ps = el.querySelectorAll('.about-body p');
          if (lbl && s.label !== undefined) lbl.textContent = s.label;
          if (h2 && s.heading !== undefined) h2.innerHTML = (s.heading || '').replace(/\n/g,'<br>');
          if (s.body !== undefined && ps.length > 0) {
            const paras = (s.body || '').split(/\n\n+/);
            ps.forEach((p,i) => { p.textContent = paras[i] || ''; p.style.display = paras[i] ? '' : 'none'; });
          }
          const statNs = el.querySelectorAll('.stat-n');
          const statLs = el.querySelectorAll('.stat-l');
          const stats = Array.isArray(s.stats) ? s.stats : [];
          const s1v = s.s1v !== undefined ? s.s1v : (stats[0]?.value ?? s.stat1_value);
          const s1l = s.s1l !== undefined ? s.s1l : (stats[0]?.label ?? s.stat1_label);
          const s2v = s.s2v !== undefined ? s.s2v : (stats[1]?.value ?? s.stat2_value);
          const s2l = s.s2l !== undefined ? s.s2l : (stats[1]?.label ?? s.stat2_label);
          const s3v = s.s3v !== undefined ? s.s3v : (stats[2]?.value ?? s.stat3_value);
          const s3l = s.s3l !== undefined ? s.s3l : (stats[2]?.label ?? s.stat3_label);
          [[s1v,s1l],[s2v,s2l],[s3v,s3l]].forEach(([v,l],i)=>{
            if (statNs[i] && v !== undefined) statNs[i].textContent = v;
            if (statLs[i] && l !== undefined) statLs[i].textContent = l;
          });
          break;
        }
        case 'release': {
          const eyebrow = el.querySelector('.drop-eyebrow');
          const title = el.querySelector('.drop-title');
          const notifyLbl = el.querySelector('.notify-label');
          const notifyBox = el.querySelector('.notify-box');
          if (eyebrow && s.eyebrow !== undefined) eyebrow.textContent = s.eyebrow;
          if (title && s.title !== undefined) {
            const span = title.querySelector('span');
            const lines = (s.title || '').split('\n');
            title.innerHTML = (lines[0]||'Release') + '<br>' + (span ? `<span>${lines[1]||'001'}</span>` : (lines[1]||'001'));
          }
          if (notifyLbl && s.notify_label !== undefined) notifyLbl.textContent = s.notify_label;
          const showNotify = s.notify_on !== undefined ? s.notify_on : s.show_notify;
          if (notifyBox) notifyBox.style.display = showNotify ? '' : 'none';
          if (s.launch_date) {
            window.__zwDropDate = new Date(s.launch_date + 'T00:00:00');
          }
          break;
        }
        case 'products': {
          const secHead = el.closest('.drop-wrap')?.querySelector('.sec-head h2') || el.querySelector('.sec-head h2');
          const secSub = el.closest('.drop-wrap')?.querySelector('.sec-head span') || el.querySelector('.sec-head span');
          if (secHead && s.title !== undefined) secHead.textContent = s.title;
          if (secSub && s.subtitle !== undefined) secSub.textContent = s.subtitle;
          // Trigger product load â€” applyBuilderConfig shows the section but doesn't populate the grid
          if (sec.visible && typeof loadProducts === 'function') setTimeout(loadProducts, 0);
          break;
        }
        case 'spacer': {
          const h = {sm:'2rem',md:'4rem',lg:'8rem'}[s.height]||'4rem';
          el.style.height = h;
          break;
        }
        case 'text': {
          const h = el.querySelector('[data-builder-heading]');
          const b = el.querySelector('[data-builder-body]');
          const cta = el.querySelector('[data-builder-cta]');
          if (h && s.heading !== undefined) { h.textContent = s.heading||''; h.style.display = s.heading?'':'none'; }
          if (b && s.body !== undefined) b.textContent = s.body||'';
          if (cta && s.cta_text !== undefined) { cta.textContent = s.cta_text||''; cta.href = s.cta_url||'#'; cta.style.display = s.cta_text?'':'none'; }
          break;
        }
        case 'image_cta':
        case 'img_cta': {
          const img = el.querySelector('[data-builder-img]');
          const btn = el.querySelector('[data-builder-btn]');
          if (img && s.image !== undefined) { img.src = typeof window.optimizeImage === 'function' ? window.optimizeImage(s.image, 1200) : (s.image||''); img.alt = s.alt||''; }
          const btnVisible = s.btn_on !== undefined ? s.btn_on : s.btn_visible;
          if (btn && s.btn_text !== undefined) { btn.textContent = s.btn_text||''; btn.href = s.btn_url||'#'; btn.style.display = btnVisible?'':'none'; }
          break;
        }
        case 'custom':
        case 'html': {
          if (s.html !== undefined) el.innerHTML = s.html||'';
          break;
        }
        case 'numbers': {
          el.className = 'builder-numbers-section';
          el.style.cssText = 'padding:5rem 2.5rem;text-align:center';
          if (s.sec_bg) el.style.background = s.sec_bg;
          const nitems = (s.items||[]);
          el.innerHTML = `${s.heading?`<h2 data-builder-heading style="font-family:var(--fw);font-size:clamp(1.4rem,4vw,1.8rem);letter-spacing:.1em;text-transform:uppercase;margin-bottom:2.5rem;font-weight:700;font-style:italic">${s.heading}</h2>`:''}
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:2rem;max-width:900px;margin:0 auto">
            ${nitems.map(it=>`<div><div style="font-family:var(--fw);font-size:clamp(2.5rem,8vw,4rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">${it.value||''}</div><div style="font-family:var(--fm,var(--fb));font-size:.65rem;letter-spacing:.2em;text-transform:uppercase;opacity:.55;margin-top:.5rem">${it.label||''}</div></div>`).join('')}
            </div>`;
          break;
        }
        case 'press': {
          el.className = 'builder-press-section';
          el.style.cssText = 'padding:3.5rem 2.5rem;text-align:center;border-top:1px solid rgba(244,241,235,.08);border-bottom:1px solid rgba(244,241,235,.08)';
          if (s.sec_bg) el.style.background = s.sec_bg;
          const pritems = (s.items||[]);
          el.innerHTML = `${s.heading?`<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-bottom:1.5rem">${s.heading}</div>`:''}
            <div style="display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:2rem 3rem">
            ${pritems.map(it=>`<span style="font-family:var(--fw);font-size:1.4rem;font-weight:700;font-style:italic;letter-spacing:.08em;text-transform:uppercase;opacity:.5">${it.name||''}</span>`).join('')}
            </div>`;
          break;
        }
        case 'faq': {
          el.className = 'builder-faq-section';
          el.style.cssText = 'padding:5rem 2.5rem';
          if (s.sec_bg) el.style.background = s.sec_bg;
          const faqWrap = document.createElement('div');
          faqWrap.style.cssText = 'max-width:800px;margin:0 auto';
          const faqitems = (s.items||[]);
          faqWrap.innerHTML = `${s.heading?`<h2 data-builder-heading style="font-family:var(--fw);font-size:clamp(1.6rem,5vw,2.4rem);letter-spacing:.08em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:2rem">${s.heading}</h2>`:''}
            <div style="border-top:1px solid rgba(244,241,235,.12)">
            ${faqitems.map(it=>`<details style="border-bottom:1px solid rgba(244,241,235,.12)"><summary style="padding:1.1rem 0;cursor:pointer;font-family:var(--fw);font-size:1rem;letter-spacing:.04em;list-style:none;display:flex;justify-content:space-between;align-items:center">${it.q||''}<span style="font-size:.8rem;opacity:.4;flex-shrink:0;margin-left:.5rem">+</span></summary><div style="padding:0 0 1.2rem;opacity:.65;line-height:1.7;font-size:.9rem">${it.a||''}</div></details>`).join('')}
            </div>`;
          el.innerHTML = '';
          el.appendChild(faqWrap);
          break;
        }
        case 'email_capture': {
          el.className = 'builder-email-capture-section';
          el.style.cssText = `padding:6rem 2.5rem;text-align:center;background:${s.bg_color||s.sec_bg||'transparent'}`;
          el.innerHTML = `<div style="max-width:520px;margin:0 auto">
            ${s.heading?`<h2 data-builder-heading style="font-family:var(--fw);font-size:clamp(1.8rem,5vw,2.6rem);letter-spacing:.1em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:.75rem">${s.heading}</h2>`:''}
            ${s.subtext?`<p style="opacity:.6;margin-bottom:1.8rem;line-height:1.6;font-size:.95rem">${s.subtext}</p>`:''}
            <div style="display:flex;gap:.5rem;max-width:400px;margin:0 auto">
              <input type="email" placeholder="${s.placeholder||'your@email.com'}" style="flex:1;background:rgba(244,241,235,.06);border:1px solid rgba(244,241,235,.15);color:inherit;padding:.75rem 1rem;font-family:var(--fb);font-size:.9rem;outline:none">
              <button style="background:var(--paper,#f4f1eb);color:var(--ink,#09090b);border:none;padding:.75rem 1.4rem;font-family:var(--fw);font-size:.8rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;white-space:nowrap">${s.btn_text||'Join'}</button>
            </div>
            </div>`;
          break;
        }
        case 'logos': {
          el.className = 'builder-logos-section';
          el.style.cssText = 'padding:2.5rem 2.5rem;text-align:center';
          if (s.sec_bg) el.style.background = s.sec_bg;
          const logositems = (s.items||[]);
          el.innerHTML = `${s.heading?`<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.35;margin-bottom:1.2rem">${s.heading}</div>`:''}
            <div style="display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:1.5rem 2.5rem">
            ${logositems.map(it=>it.src?`<img src="${it.src}" alt="${it.alt||it.name||''}" style="height:28px;width:auto;opacity:.45;filter:brightness(0) invert(1)">`:it.name?`<span style="font-family:var(--fw);font-size:1.1rem;font-weight:700;font-style:italic;letter-spacing:.06em;text-transform:uppercase;opacity:.35">${it.name}</span>`:''  ).join('')}
            </div>`;
          break;
        }
        case 'richtext': {
          el.className = 'builder-richtext-section';
          el.style.cssText = `padding:4rem 2.5rem;max-width:760px;margin:0 auto;text-align:${s.align||'left'}`;
          if (s.sec_bg) el.style.background = s.sec_bg;
          el.innerHTML = `<div data-builder-body style="line-height:1.85;font-size:1rem;opacity:.85;white-space:pre-line">${s.content||''}</div>`;
          break;
        }
        case 'split': {
          el.className = 'builder-split-section';
          const imgSide = s.image_side||'left';
          const isFull = !s.layout_width || s.layout_width === 'full';
          const px = isFull ? '0' : '2.5rem';
          const mw = isFull ? 'none' : (s.layout_width === 'contained' ? '1200px' : `${s.layout_width}px`);
          el.style.cssText = `background:${s.bg_color||s.sec_bg||'transparent'};`;
          if (s.sec_bg && !s.bg_color) el.style.background = s.sec_bg;
          const optSplitImg = typeof window.optimizeImage === 'function' && s.image ? window.optimizeImage(s.image, 1200) : s.image;
          const imgPart = s.image?`<div style="flex:1 1 400px;min-height:${s.image_height||500}px;background:url(${optSplitImg}) center/cover no-repeat"></div>`:'';
          const txtPart = `<div style="flex:1 1 400px;padding:4rem 3rem">${s.label?`<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.5;margin-bottom:1rem">${s.label}</div>`:''}<h2 style="font-family:var(--fw);font-size:clamp(1.8rem,4vw,2.8rem);font-weight:900;font-style:italic;letter-spacing:.06em;text-transform:uppercase;line-height:1.05;margin-bottom:1.2rem">${s.heading||''}</h2><p style="opacity:.65;line-height:1.75;font-size:.95rem;margin-bottom:1.8rem">${s.body||''}</p>${s.cta_text?`<a href="${s.cta_url||'#'}" style="display:inline-block;border:1px solid currentColor;padding:.65rem 1.6rem;font-family:var(--fm,var(--fb));font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;color:inherit">${s.cta_text}</a>`:''}</div>`;
          const innerHTML = imgSide==='left' ? (imgPart+txtPart) : (txtPart+imgPart);
          el.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:center;min-height:${s.image_height||500}px;padding:0 ${px};max-width:${mw};margin:0 auto;${!isFull && s.bg_color ? 'border-radius:12px;overflow:hidden;' : ''}">${innerHTML}</div>`;
          break;
        }
        case 'cta': {
          el.className = 'builder-cta-section';
          const ctaAlign = s.align||'center';
          el.style.cssText = `padding:6rem 2.5rem;text-align:${ctaAlign};background:${s.bg_color||s.sec_bg||'transparent'};color:${s.text_color||'inherit'}`;
          el.innerHTML = `<div style="max-width:700px;margin:0 auto">
            ${s.heading?`<h2 style="font-family:var(--fw);font-size:clamp(2rem,6vw,3.2rem);font-weight:900;font-style:italic;letter-spacing:.08em;text-transform:uppercase;line-height:1.05;margin-bottom:1rem">${s.heading}</h2>`:''}
            ${s.subtext?`<p style="opacity:.65;line-height:1.7;margin-bottom:2rem;font-size:1rem">${s.subtext}</p>`:''}
            ${s.btn_text?`<a href="${s.btn_url||'#'}" style="display:inline-block;background:${s.btn_style==='solid'?'currentColor':'transparent'};color:${s.btn_style==='solid'?(s.bg_color||'#09090b'):'currentColor'};border:1px solid currentColor;padding:.75rem 2rem;font-family:var(--fm,var(--fb));font-size:.7rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;text-decoration:none">${s.btn_text}</a>`:''}
          </div>`;
          break;
        }
        case 'features': {
          el.className = 'builder-features-section';
          el.style.cssText = 'padding:5rem 2.5rem;text-align:center';
          if (s.sec_bg) el.style.background = s.sec_bg;
          const fitems = (s.items||[]);
          el.innerHTML = `${s.heading?`<h2 style="font-family:var(--fw);font-size:clamp(1.6rem,4vw,2.4rem);letter-spacing:.08em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:3rem">${s.heading}</h2>`:''}
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:2rem;max-width:1000px;margin:0 auto">
            ${fitems.map(it=>`<div style="padding:1.5rem"><div style="font-size:2rem;margin-bottom:1rem">${it.icon||''}</div><div style="font-family:var(--fw);font-size:1rem;font-weight:700;font-style:italic;letter-spacing:.06em;text-transform:uppercase;margin-bottom:.6rem">${it.title||''}</div><div style="opacity:.6;font-size:.88rem;line-height:1.6">${it.desc||''}</div></div>`).join('')}
            </div>`;
          break;
        }
        case 'testimonials': {
          el.className = 'builder-testimonials-section';
          el.style.cssText = 'padding:5rem 2.5rem;text-align:center';
          if (s.sec_bg) el.style.background = s.sec_bg;
          const titems = (s.items||[]);
          el.innerHTML = `${s.heading?`<h2 style="font-family:var(--fw);font-size:clamp(1.6rem,4vw,2.4rem);letter-spacing:.08em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:3rem">${s.heading}</h2>`:''}
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:2rem;max-width:1000px;margin:0 auto">
            ${titems.map(it=>`<div style="background:rgba(244,241,235,.04);border:1px solid rgba(244,241,235,.08);padding:2rem;text-align:left"><div style="color:var(--gold);margin-bottom:1rem;font-size:1.1rem">${'★'.repeat(Math.min(5,Math.max(1,parseInt(it.rating)||5)))}</div><p style="line-height:1.7;margin-bottom:1.2rem;opacity:.8;font-size:.95rem">"${it.quote||''}"</p><div style="font-family:var(--fw);font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;opacity:.5">${it.author||''}</div></div>`).join('')}
            </div>`;
          break;
        }
        case 'banner': {
          el.className = 'builder-banner-section';
          el.style.cssText = `padding:1.5rem 2.5rem;text-align:center;background:${s.bg_color||s.sec_bg||'#09090b'};color:${s.text_color||'#f4f1eb'}`;
          el.innerHTML = `<span style="font-family:var(--fm,var(--fb));font-size:.8rem;letter-spacing:.12em;text-transform:uppercase">${s.text||''}</span>${s.link_text?` <a href="${escapeHomeFavoriteHtml(zwSafeUrl(s.link_url))}" style="color:inherit;margin-left:.75rem;text-decoration:underline;font-family:var(--fm,var(--fb));font-size:.8rem;letter-spacing:.12em;text-transform:uppercase">${s.link_text}</a>`:''}`;
          break;
        }
        case 'gallery': {
          el.className = 'builder-gallery-section';
          const isFull = !s.layout_width || s.layout_width === 'full';
          const px = isFull ? '0' : '2.5rem';
          const mw = isFull ? 'none' : (s.layout_width === 'contained' ? '1200px' : `${s.layout_width}px`);
          el.style.cssText = `padding:3rem 0;`;
          if (s.sec_bg) el.style.background = s.sec_bg;
          const cols = parseInt(s.columns)||3;
          const aspectMap = {square:'1/1',portrait:'3/4',wide:'16/9'};
          const aspect = aspectMap[s.aspect]||'1/1';
          const gimgs = Array.isArray(s.images) ? s.images : [];
          if(gimgs.length===0){
            el.innerHTML=`<div style="padding:0 ${px};max-width:${mw};margin:0 auto;"><div style="opacity:.5;text-align:center">Add images to gallery</div></div>`;
            break;
          }
          el.innerHTML = `<div style="padding:0 ${px};max-width:${mw};margin:0 auto;">
            ${s.heading?`<h2 style="font-family:var(--fw);font-size:clamp(1.5rem,3vw,2.2rem);text-transform:uppercase;font-weight:800;font-style:italic;text-align:center;margin-bottom:2rem">${s.heading}</h2>`:''}
            <div class="zw-mobile-scroll-grid" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:1rem">
            ${gimgs.map(img=>`${img.link?`<a href="${img.link}"`:'<div'} style="aspect-ratio:${aspect};overflow:hidden;display:block"><img src="${typeof window.optimizeImage==='function'?window.optimizeImage(img.src, 1200):img.src}" alt="${img.alt||''}" style="width:100%;height:100%;object-fit:cover;transition:transform .4s ease" loading="lazy" fetchpriority="low" onmouseover="this.style.transform='scale(1.03)'" onmouseout="this.style.transform='scale(1)'">${img.link?'</a>':'</div>'}`).join('')}
            </div>
          </div>`;
          break;
        }
        case 'video': {
          el.className = 'builder-video-section';
          el.style.cssText = 'padding:3rem 2.5rem;max-width:900px;margin:0 auto';
          if (s.sec_bg) el.style.background = s.sec_bg;
          let videoSrc = '';
          const url = s.url||'';
          const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
          const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
          if (ytMatch) {
            const params = new URLSearchParams({rel:'0'});
            if (s.autoplay) params.set('autoplay','1');
            if (s.muted) params.set('mute','1');
            if (!s.controls) params.set('controls','0');
            videoSrc = `https://www.youtube.com/embed/${ytMatch[1]}?${params}`;
          } else if (vimeoMatch) {
            videoSrc = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
          }
          el.innerHTML = videoSrc
            ? `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden"><iframe src="${videoSrc}" style="position:absolute;inset:0;width:100%;height:100%;border:none" allowfullscreen allow="autoplay"></iframe></div>${s.caption?`<p style="text-align:center;opacity:.45;font-size:.8rem;margin-top:1rem">${s.caption}</p>`:''}`
            : `<div style="background:rgba(244,241,235,.05);border:1px dashed rgba(244,241,235,.15);padding:4rem;text-align:center;opacity:.4;font-size:.8rem">Paste a YouTube or Vimeo URL in the editor</div>`;
          break;
        }
        case 'countdown': {
          el.className = 'builder-countdown-section';
          el.style.cssText = `padding:5rem 2.5rem;text-align:${s.align||'center'}`;
          if (s.sec_bg) el.style.background = s.sec_bg;
          const cdId = 'builder-cd-' + sec.id;
          el.innerHTML = `${s.heading?`<h2 style="font-family:var(--fw);font-size:clamp(1.4rem,4vw,2rem);letter-spacing:.1em;text-transform:uppercase;font-weight:700;font-style:italic;margin-bottom:2rem">${s.heading}</h2>`:''}
            <div id="${cdId}" style="display:flex;gap:2.5rem;justify-content:${s.align==='left'?'flex-start':'center'};flex-wrap:wrap">
              <div><div class="cd-n" style="font-family:var(--fw);font-size:clamp(3rem,10vw,5rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">--</div>${s.show_labels!==false?`<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-top:.4rem">Days</div>`:''}</div>
              <div><div class="cd-n" style="font-family:var(--fw);font-size:clamp(3rem,10vw,5rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">--</div>${s.show_labels!==false?`<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-top:.4rem">Hours</div>`:''}</div>
              <div><div class="cd-n" style="font-family:var(--fw);font-size:clamp(3rem,10vw,5rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">--</div>${s.show_labels!==false?`<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-top:.4rem">Minutes</div>`:''}</div>
              <div><div class="cd-n" style="font-family:var(--fw);font-size:clamp(3rem,10vw,5rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">--</div>${s.show_labels!==false?`<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-top:.4rem">Seconds</div>`:''}</div>
            </div>`;
          // Start countdown ticker
          (function startCd() {
            const target = s.launch_date ? new Date(s.launch_date) : null;
            if (!target) return;
            const cdEl = document.getElementById(cdId);
            if (!cdEl) return;
            const nums = cdEl.querySelectorAll('.cd-n');
            function tick() {
              const diff = target - Date.now();
              if (diff <= 0) { nums.forEach(n=>n.textContent='00'); return; }
              const d = Math.floor(diff/864e5);
              const h = Math.floor((diff%864e5)/36e5);
              const m = Math.floor((diff%36e5)/6e4);
              const sc = Math.floor((diff%6e4)/1e3);
              const pad = n=>String(n).padStart(2,'0');
              if (nums[0]) nums[0].textContent=pad(d);
              if (nums[1]) nums[1].textContent=pad(h);
              if (nums[2]) nums[2].textContent=pad(m);
              if (nums[3]) nums[3].textContent=pad(sc);
            }
            tick();
            if (el._zwCdTimer) clearInterval(el._zwCdTimer);
            el._zwCdTimer = setInterval(tick, 1000);
          })();
          break;
        }
        case 'hero_carousel': {
          el.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
          el.className = 'builder-hero-carousel-section';
          const hMap = { full:'100vh', tall:'75vh', half:'50vh', short:'40vh' };
          el.style.cssText = `position:relative; overflow:hidden; width:100%; height:${hMap[s.height]||'100vh'}; background:${s.sec_bg||'#09090b'};`;
          
          const slides = Array.isArray(s.slides) ? s.slides : [];
          if(slides.length === 0) {
             el.innerHTML = '<div style="padding:4rem;text-align:center;color:#fff">Add slides in the editor</div>';
             break;
          }

          let slidesHtml = '';
          let dotsHtml = '';
          slides.forEach((sl, i) => {
             const active = i === 0 ? ' active' : '';
             
             let mediaHtml = '';
             const isVideo = sl.media_type === 'video' || (sl.media_url && sl.media_url.match(/\.(mp4|webm|mov)(\?.*)?$/i));
             if (isVideo) {
                const auto = (i === 0 && s.autoplay !== false) ? ' autoplay' : '';
                const vidMode = sl.video_duration_mode || 'full';
                const loopAttr = (vidMode === 'full') ? '' : ' loop';
                mediaHtml = `<video class="zw-hc-media" src="${sl.media_url||''}" poster="${sl.video_poster||''}" playsinline${loopAttr} muted${auto} style="object-position:center ${sl.focal_y??50}%"></video>`;
             } else {
                const lazy = i === 0 ? 'fetchpriority="high"' : 'loading="lazy"';
                const optDesktop = typeof window.optimizeImage === 'function' ? window.optimizeImage(sl.media_url, 1400) : sl.media_url;
                const optMobile = typeof window.optimizeImage === 'function' ? window.optimizeImage(sl.media_url_mobile, 800) : sl.media_url_mobile;
                mediaHtml = `<picture class="zw-hc-media">
                   ${sl.media_url_mobile ? `<source media="(max-width:768px)" srcset="${optMobile||''}">` : ''}
                   <img src="${optDesktop||''}" alt="" style="object-position:center ${sl.focal_y??50}%" ${lazy} decoding="async">
                </picture>`;
             }

             slidesHtml += `
             <div class="zw-hc-slide${active}" data-index="${i}" data-duration="${sl.duration||''}" data-video-mode="${sl.video_duration_mode||'full'}">
                ${mediaHtml}
                <div class="zw-hc-overlay" style="opacity:${(sl.overlay_opacity??30)/100}"></div>
                <div class="zw-hc-content" style="text-align:${sl.text_align||'center'}; color:${sl.text_color||'#ffffff'}">
                   ${sl.eyebrow ? `<p class="zw-hc-eyebrow">${sl.eyebrow}</p>` : ''}
                   ${sl.heading ? `<h2 class="zw-hc-heading">${sl.heading.replace(/\n/g,'<br>')}</h2>` : ''}
                   ${sl.subtext ? `<p class="zw-hc-subtext">${sl.subtext}</p>` : ''}
                   ${sl.cta_text ? `<a class="zw-hc-cta btn-${sl.cta_style||'solid'}" href="${sl.cta_url||'#'}">${sl.cta_text}</a>` : ''}
                </div>
                ${sl.watch_btn ? `<button class="zw-hc-watch" onclick="openWatchModal('${sl.watch_url||''}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> ${sl.watch_label||'Watch'}</button>` : ''}
             </div>`;
             
             dotsHtml += `<button class="zw-hc-dot${active}" data-index="${i}" aria-label="Slide ${i+1}"></button>`;
          });

          el.innerHTML = `
          <div class="zw-hc-track zw-hc-trans-${s.transition||'fade'}">
             ${slidesHtml}
          </div>
          <div class="zw-hc-controls">
             <div></div>
             ${(s.show_dots !== false && slides.length > 1) ? `<div class="zw-hc-dots">${dotsHtml}</div>` : '<div></div>'}
             <div class="zw-hc-nav">
                ${s.show_pause !== false ? `<div class="zw-hc-pause-wrap">
                  <svg class="zw-hc-progress-svg"><circle cx="20" cy="20" r="18" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2"/><circle class="zw-hc-progress-ring" cx="20" cy="20" r="18" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="113" stroke-dashoffset="113"/></svg>
                  <button class="zw-hc-pause" aria-label="Pause/Play"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></button>
                </div>` : ''}
                ${(s.show_arrows !== false && slides.length > 1) ? `
                <button class="zw-hc-prev" aria-label="Previous"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button>
                <button class="zw-hc-next" aria-label="Next"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>
                ` : ''}
             </div>
          </div>
          `;

          const autoplay = s.autoplay !== false;
          const interval = s.autoplay_interval || 5000;
          const loop = s.loop !== false;
          
          (function initCarousel() {
             const track = el.querySelector('.zw-hc-track');
             const slideEls = Array.from(el.querySelectorAll('.zw-hc-slide'));
             const dots = Array.from(el.querySelectorAll('.zw-hc-dot'));
             const btnPrev = el.querySelector('.zw-hc-prev');
             const btnNext = el.querySelector('.zw-hc-next');
             const btnPause = el.querySelector('.zw-hc-pause');
             if(!track || slideEls.length === 0) return;

             let curIdx = 0;
             let isPaused = false;
             let elapsed = 0;
             let lastTick = Date.now();
             let rafId = null;
             const progressRing = el.querySelector('.zw-hc-progress-ring');
             const circumference = 113; // 2 * PI * 18
             
             const setProgress = (percent) => {
                if(progressRing) {
                   const offset = circumference - (percent / 100) * circumference;
                   progressRing.style.strokeDashoffset = offset;
                }
             };

             const update = (newIdx) => {
                if(!loop) {
                   if(newIdx < 0) newIdx = 0;
                   if(newIdx >= slideEls.length) newIdx = slideEls.length - 1;
                } else {
                   if(newIdx < 0) newIdx = slideEls.length - 1;
                   if(newIdx >= slideEls.length) newIdx = 0;
                }
                if(newIdx === curIdx) return;
                
                const oldVid = slideEls[curIdx].querySelector('video');
                if(oldVid) { oldVid.pause(); oldVid.currentTime = 0; }
                
                slideEls[curIdx].classList.remove('active');
                if(dots[curIdx]) dots[curIdx].classList.remove('active');
                
                curIdx = newIdx;
                slideEls[curIdx].classList.add('active');
                if(dots[curIdx]) dots[curIdx].classList.add('active');
                
                const newVid = slideEls[curIdx].querySelector('video');
                if(newVid && !isPaused) { newVid.currentTime = 0; newVid.play().catch(()=>{}); }
                
                elapsed = 0;
                lastTick = Date.now();
                setProgress(0);
             };
             
             const next = () => update(curIdx + 1);
             const prev = () => update(curIdx - 1);
             
             if(btnPrev) btnPrev.onclick = () => { isPaused=false; updatePauseIcon(); prev(); };
             if(btnNext) btnNext.onclick = () => { isPaused=false; updatePauseIcon(); next(); };
             dots.forEach(d => d.onclick = () => { isPaused=false; updatePauseIcon(); update(parseInt(d.dataset.index)); });
             
             const updatePauseIcon = () => {
                if(!btnPause) return;
                const iconPath = isPaused 
                  ? `<path d="M8 5v14l11-7z"/>`
                  : `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
                // update the icon inside the button while preserving the SVG wrapper
                const svgEl = btnPause.querySelector('svg');
                if(svgEl) svgEl.innerHTML = iconPath;
             };
             
             if(btnPause) {
                btnPause.onclick = () => {
                   isPaused = !isPaused;
                   updatePauseIcon();
                   const vid = slideEls[curIdx].querySelector('video');
                   if(isPaused) {
                      if(vid) vid.pause();
                   } else {
                      lastTick = Date.now(); // prevent jumping elapsed time
                      if(vid) vid.play().catch(()=>{});
                   }
                };
             }
             
             const tick = () => {
                rafId = requestAnimationFrame(tick);
                const now = Date.now();
                const dt = now - lastTick;
                lastTick = now;
                
                if(isPaused || !autoplay || slideEls.length <= 1) return;

                const curSlide = slideEls[curIdx];
                const isVideoModeFull = curSlide.dataset.videoMode === 'full';
                const vid = curSlide.querySelector('video');

                if (isVideoModeFull && vid) {
                   // Video 'ended' event handles advancement; just update progress ring
                   if(vid.duration && !isNaN(vid.duration) && vid.duration > 0) {
                      const percent = (vid.currentTime / vid.duration) * 100;
                      setProgress(Math.min(100, Math.max(0, percent)));
                   }
                } else {
                   elapsed += dt;
                   const slideDur = parseInt(curSlide.dataset.duration) || interval;
                   const percent = (elapsed / slideDur) * 100;
                   setProgress(Math.min(100, Math.max(0, percent)));
                   if (elapsed >= slideDur) next();
                }
             };
             rafId = requestAnimationFrame(tick);

             // Bind 'ended' event on all video slides set to 'full' duration mode
             // This is far more reliable than polling vid.ended in rAF
             slideEls.forEach((sl, i) => {
                if(sl.dataset.videoMode === 'full') {
                   const v = sl.querySelector('video');
                   if(v) {
                      v.addEventListener('ended', () => {
                         if(!isPaused && curIdx === i) next();
                      });
                   }
                }
             });
             
             let touchStartX = 0;
             let touchEndX = 0;
             track.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, {passive:true});
             track.addEventListener('touchend', e => { 
                touchEndX = e.changedTouches[0].screenX; 
                handleSwipe();
             }, {passive:true});
             
             const handleSwipe = () => {
                const diff = touchStartX - touchEndX;
                if(Math.abs(diff) > 50) {
                   isPaused = false;
                   updatePauseIcon();
                   if(diff > 0) next(); else prev();
                }
             };

          })();
          break;
        }
        case 'media_grid': {
          el.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
          el.className = 'builder-media-grid-section';
          const isFull = !s.layout_width || s.layout_width === 'full';
          const px = isFull ? '0' : '2.5rem';
          const mw = isFull ? 'none' : (s.layout_width === 'contained' ? '1200px' : `${s.layout_width}px`);
          el.style.cssText = `background:${s.sec_bg||'transparent'}`;
          
          const cards = Array.isArray(s.cards) ? s.cards : [];
          if(cards.length === 0) {
             el.innerHTML = `<div style="padding:4rem ${px};max-width:${mw};margin:0 auto;text-align:center;opacity:0.5">Add cards in the editor</div>`;
             break;
          }
          
          const layout = s.layout || 'grid';
          const cols = s.columns || 3;
          const gapMap = { none:'0', xs:'.5rem', sm:'1rem', md:'1.5rem', lg:'2.5rem' };
          const gap = gapMap[s.gap||'md'] || '1.5rem';
          const aspectMap = { square:'1/1', portrait:'3/4', wide:'16/9', auto:'auto' };
          const aspect = aspectMap[s.aspect||'portrait'] || '3/4';
          
          let trackClass = 'zw-mg-track';
          let trackStyle = '';
          
          if (layout === 'grid') {
             trackClass += ' zw-mg-grid zw-mobile-scroll-grid';
             trackStyle = `display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap:${gap};`;
          } else {
             trackClass += ' zw-mg-scroll';
             trackStyle = `display:flex; gap:${gap}; overflow-x:auto; scroll-snap-type:x mandatory; padding-bottom:1rem; scrollbar-width:none;`;
          }

          let cardsHtml = '';
          cards.forEach(cd => {
             const tag = cd.link_url ? 'a' : 'div';
             const href = cd.link_url ? ` href="${cd.link_url}"` : '';
             const pos = cd.label_position || 'below'; 
             
             let mediaHtml = '';
             const ht = s.card_height ? `height:${s.card_height};` : `aspect-ratio:${aspect};`;
             const isVideo = cd.media_type === 'video' || (cd.media_url && cd.media_url.match(/\.(mp4|webm|mov)(\?.*)?$/i));
             if (isVideo) {
                mediaHtml = `<video src="${cd.media_url||''}" poster="${cd.video_poster||''}" playsinline autoplay loop muted class="zw-mg-media" style="${ht}"></video>`;
             } else {
                const optImg = typeof window.optimizeImage === 'function' ? window.optimizeImage(cd.media_url, 800) : cd.media_url;
                mediaHtml = `<img src="${optImg||''}" alt="" class="zw-mg-media" style="${ht}" loading="lazy" decoding="async">`;
             }
             
             const labelHtml = cd.label ? `<p class="zw-mg-label zw-mg-label-${pos}">${cd.label}</p>` : '';
             const watchHtml = cd.watch_btn ? `<button class="zw-mg-watch" onclick="event.preventDefault(); openWatchModal('${cd.watch_url||''}')"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> ${cd.watch_label||'Watch'}</button>` : '';

             const cardStyle = layout === 'scroll' ? `flex:0 0 auto; width:min(85vw, 360px); scroll-snap-align:start; position:relative;` : `position:relative; display:block; text-decoration:none; color:inherit;`;
             
             cardsHtml += `
             <${tag}${href} class="zw-mg-card" style="${cardStyle}">
                <div class="zw-mg-media-wrap" style="position:relative; overflow:hidden;">
                   ${mediaHtml}
                   ${pos.includes('overlay') ? labelHtml : ''}
                   ${watchHtml}
                </div>
                ${pos === 'below' ? labelHtml : ''}
             </${tag}>`;
          });
          
          el.innerHTML = `
             <div style="padding:4rem ${px}; max-width:${mw}; margin:0 auto;">
                ${s.heading ? `<h2 class="zw-mg-heading">${s.heading}</h2>` : ''}
                <div class="${trackClass}" style="${trackStyle}">
                   ${cardsHtml}
                </div>
             </div>
          `;
          break;
        }
      }

      // Per-section style overrides.
      // Use !important so a chosen section background reliably beats the
      // light/super-light mode rules (e.g. .drop-wrap { background:var(--ink) }),
      // which otherwise win over a plain inline style for built-in sections.
      if (s.sec_bg) el.style.setProperty('background', s.sec_bg, 'important');
      else el.style.removeProperty('background'); // clear when unset so mode bg returns
      if (s.pad_top) el.style.paddingTop = s.pad_top + 'px';
      if (s.pad_bot) el.style.paddingBottom = s.pad_bot + 'px';
      
      if (s.font_head_override && _FONT_STACKS[s.font_head_override]) {
        el.style.setProperty('--zw-font-head', _FONT_STACKS[s.font_head_override]);
        el.style.setProperty('--fw', _FONT_STACKS[s.font_head_override]);
        _loadBuilderFont(s.font_head_override);
      } else {
        el.style.removeProperty('--zw-font-head');
        el.style.removeProperty('--fw');
      }
      
      if (s.font_body_override && _FONT_STACKS[s.font_body_override]) {
        el.style.setProperty('--zw-font-body', _FONT_STACKS[s.font_body_override]);
        el.style.setProperty('--fb', _FONT_STACKS[s.font_body_override]);
        _loadBuilderFont(s.font_body_override);
      } else {
        el.style.removeProperty('--zw-font-body');
        el.style.removeProperty('--fb');
      }
    });
  }

  // URL param is the most reliable check â€” doesn't depend on iframe context
  const isBuilderPreview =
    new URLSearchParams(window.location.search).get('builder') === '1' ||
    (function(){ try{ return window.self !== window.top; }catch(_){ return false; } }());

  if (isBuilderPreview) {
    window.__ZW_BUILDER_PREVIEW__ = true;

    // Apply any config that was already in localStorage when page loaded
    let _lastRaw = null;
    function checkBuilderCfg() {
      try {
        const raw = localStorage.getItem('_zw_builder_cfg');
        if (!raw || raw === _lastRaw) return;
        _lastRaw = raw;
        applyBuilderConfig(JSON.parse(raw));
      } catch(e) {}
    }

    // Apply on load in case config already written
    checkBuilderCfg();

    // Poll every 300ms as fallback
    setInterval(checkBuilderCfg, 300);

    // Instant storage event listener (handles cross-document updates instantly)
    window.addEventListener('storage', e => {
      if (e.key === '_zw_builder_cfg') {
        try {
          _lastRaw = e.newValue; // keep in sync so checkBuilderCfg doesn't re-apply redundantly
          applyBuilderConfig(JSON.parse(e.newValue));
        } catch(err) {}
      }
    });

    // Also keep postMessage as fallback. SECURITY: only accept messages from our
    // own origin (the admin page-builder, served same-origin). Without this, any
    // site that framed us could post a ZW_BUILDER_CONFIG and inject HTML (XSS).
    window.addEventListener('message', e => {
      if (e.origin !== window.location.origin) return;
      if (e.data && e.data.type === 'ZW_BUILDER_CONFIG') {
        applyBuilderConfig(e.data);
      }
      if (e.data && e.data.type === 'ZW_SCROLL_TO_SECTION') {
        const secId = e.data.sectionId;
        const sectionMap = {
          hero:    document.querySelector('.hero'),
          marquee: document.querySelector('.marquee'),
          about:   document.querySelector('.section-about'),
          release: document.querySelector('.drop-wrap'),
          products:document.querySelector('.products-section')
        };
        const el = sectionMap[secId] || document.getElementById(secId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });

    // Re-apply after Supabase finishes loading (bar was hidden when first apply ran, now it's visible)
    window.__zwReapplyBuilder = function() {
      try {
        const raw = localStorage.getItem('_zw_builder_cfg');
        if (raw) { _lastRaw = raw; applyBuilderConfig(JSON.parse(raw)); }
      } catch(e) {}
    };
  }
})();

/* NAV SCROLL */
const nav = document.getElementById('nav');
let _navScrolled = false;
window.addEventListener('scroll', () => {
  const s = window.scrollY > 50;
  if (s !== _navScrolled) { _navScrolled = s; nav.classList.toggle('scrolled', s); }
}, { passive: true });

/* Bar position on mobile is handled purely by CSS â€” no JS measurement needed. */

/* SUPABASE â€” window.sb set by supabase-client.js (deferred) before DOMContentLoaded */
const SUPABASE_URL  = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
let _sb = null; // set in DOMContentLoaded once supabase-client.js has run
let _announcementBarScrollHandler = null;

function teardownAnnouncementBarScroll() {
  if (_announcementBarScrollHandler) {
    window.removeEventListener('scroll', _announcementBarScrollHandler);
    _announcementBarScrollHandler = null;
  }
}

function setAnnouncementBarLayout(barEl, navEl, isVisible) {
  // Mobile: bar top is handled by CSS variable --nav-h, no JS needed
  // Desktop: nav pushed below bar via nav.style.top; spacer holds bar height in flow
  const spacerEl = document.getElementById('bar-spacer');
  if (window.matchMedia('(max-width:900px)').matches) {
    // Bar sits below the nav via CSS on mobile; clear any desktop nav offset
    // (e.g. left behind after a resize across the breakpoint) and drop the spacer.
    if (navEl) navEl.style.top = '';
    if (spacerEl) spacerEl.style.height = '0';
  } else {
    const barH = (barEl && isVisible) ? barEl.offsetHeight : 0;
    if (navEl) navEl.style.top = barH + 'px';
    if (spacerEl) spacerEl.style.height = isVisible ? barH + 'px' : '0';
  }
}

function applyAnnouncementBar(mode, msgText) {
  const barEl = document.getElementById('bar');
  const navEl = document.getElementById('nav');
  if (!barEl) return;
  const normalizedMode = String(mode || 'on').trim().toLowerCase();
  const isMobileViewport = window.matchMedia('(max-width: 900px)').matches;

  teardownAnnouncementBarScroll();
  barEl.style.opacity = '1';
  barEl.style.pointerEvents = '';
  barEl.style.transform = '';
  if (navEl) navEl.style.transform = ''; // safety: clear any stale nav transform from earlier versions

  const textEl = document.getElementById('announcementText');
  const fallbackText = (barEl.dataset.defaultText || (textEl ? textEl.textContent : '') || '').trim();
  if (!barEl.dataset.defaultText) barEl.dataset.defaultText = fallbackText;
  if (textEl) {
    const nextText = (typeof msgText === 'string' ? msgText : '').trim();
    textEl.textContent = nextText || fallbackText;
  }

  if (normalizedMode === 'off') {
    if (isMobileViewport) {
      // On mobile, hide via display:none (no slide) to avoid leaving a gap
      barEl.style.display = 'none';
      barEl.style.transform = 'none';
      barEl.style.opacity = '1';
      barEl.style.pointerEvents = '';
    } else {
      barEl.style.display = 'none';
    }
    setAnnouncementBarLayout(barEl, navEl, false);
    return;
  }

  barEl.style.display = 'flex';
  setAnnouncementBarLayout(barEl, navEl, true);

  // Smooth the spacer's height changes on scroll hide/show — but only enable the
  // transition AFTER the initial layout has painted, so the bar's first
  // appearance (0 -> height, once settings load) doesn't animate a push-down.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const sp = document.getElementById('bar-spacer');
    if (sp) sp.style.transition = 'height .45s ease';
  }));

  if (normalizedMode !== 'scroll' && normalizedMode !== 'scrolloff') return;

  if (isMobileViewport) {
    // Mobile: the bar's transform is CSS-locked (anti-flicker), so animate
    // OPACITY instead of a slide. 'scroll' hides on scroll-down and reappears at
    // the top / on scroll-up; 'scrolloff' hides once on the first scroll-down and
    // stays gone (the handler detaches) until the page is reopened. Mirrors the
    // desktop path and the product page so all four modes behave consistently.
    barEl.style.transition = 'opacity .3s ease';
    let lastScrollY = window.scrollY;
    let isHidden = false;
    const scrollActivationAt = Date.now() + 450;
    const syncAnnouncementState = (hidden) => {
      barEl.style.opacity = hidden ? '0' : '1';
      barEl.style.pointerEvents = hidden ? 'none' : '';
    };
    syncAnnouncementState(false);
    _announcementBarScrollHandler = function() {
      const currentY = window.scrollY;
      if (document.body.dataset.scrollLocked || window.__zwScrollLocking || window.__zwScrollRestoring) { lastScrollY = currentY; return; }
      if (Date.now() < scrollActivationAt) { lastScrollY = currentY; return; }
      const scrollingDown = currentY > lastScrollY + 6;
      const scrollingUp = currentY < lastScrollY - 6;
      // 'scroll' reappears at the top / on scroll-up; 'scrolloff' stays gone.
      if (normalizedMode !== 'scrolloff' && (currentY <= 16 || scrollingUp)) {
        if (isHidden) { isHidden = false; syncAnnouncementState(false); }
      } else if (currentY > 80 && scrollingDown) {
        if (!isHidden) {
          isHidden = true; syncAnnouncementState(true);
          if (normalizedMode === 'scrolloff') teardownAnnouncementBarScroll();
        }
      }
      lastScrollY = currentY;
    };
    window.addEventListener('scroll', _announcementBarScrollHandler, { passive: true });
    return;
  }

  barEl.style.transition = 'transform 0.45s ease, opacity 0.45s ease';
  let lastScrollY = window.scrollY;
  let isHidden = false;
  const scrollActivationAt = Date.now() + 450;
  let _barHideTimer = null;
  const spacerEl = document.getElementById('bar-spacer');
  const syncAnnouncementState = (hidden) => {
    clearTimeout(_barHideTimer);
    if (hidden) {
      barEl.style.transform = 'translateY(-100%)';
      barEl.style.opacity = '0';
      barEl.style.pointerEvents = 'none';
      if (spacerEl) spacerEl.style.height = '0';
      _barHideTimer = setTimeout(() => { barEl.style.display = 'none'; if (window.__zwUpdateHeaderHeight) window.__zwUpdateHeaderHeight(); }, 460);
    } else {
      barEl.style.display = 'flex';
      void barEl.offsetHeight;
      barEl.style.transform = 'translateY(0)';
      barEl.style.opacity = '1';
      barEl.style.pointerEvents = '';
      if (spacerEl) spacerEl.style.height = barEl.offsetHeight + 'px';
    }
    setAnnouncementBarLayout(barEl, navEl, !hidden);
  };
  syncAnnouncementState(false);
  _announcementBarScrollHandler = function() {
    const currentY = window.scrollY;
    if (document.body.dataset.scrollLocked || window.__zwScrollLocking || window.__zwScrollRestoring) { lastScrollY = currentY; return; }
    if (Date.now() < scrollActivationAt) { lastScrollY = currentY; return; }
    const scrollingDown = currentY > lastScrollY + 6;
    const scrollingUp = currentY < lastScrollY - 6;
    // 'scroll' reappears at the top / on scroll-up; 'scrolloff' hides once and
    // detaches, so it stays gone until the page is reopened.
    if (normalizedMode !== 'scrolloff' && (currentY <= 16 || scrollingUp)) {
      if (isHidden) { isHidden = false; syncAnnouncementState(false); }
    } else if (currentY > 80 && scrollingDown) {
      if (!isHidden) {
        isHidden = true; syncAnnouncementState(true);
        if (normalizedMode === 'scrolloff') teardownAnnouncementBarScroll();
      }
    }
    lastScrollY = currentY;
  };
  window.addEventListener('scroll', _announcementBarScrollHandler, { passive: true });
}

/* -- SHIPPING POLICY (default until Supabase loads) -- */
window._shippingPolicy = { enabled: true, threshold: 100, standardRate: 8 };

/* -- LOAD SITE SETTINGS (announcement bar) -- */
(async function loadSiteSettings() {
  try {
    const _settingsTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
    // Reuse the early fetch kicked off in the inline script at the top of the
    // page (before CSS/JS blocked parsing). If it's already resolved the await
    // returns instantly; if it's still in-flight we just wait for it — either
    // way we avoid issuing a duplicate network request.
    const earlyFetch = window.__zwSettingsEarlyFetch || null;
    const resp = await Promise.race([
      earlyFetch || fetch(`${SUPABASE_URL}/rest/v1/site_settings?select=*`, {
        cache: 'no-store',
        headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` }
      }),
      _settingsTimeout
    ]);
    if (!resp.ok) {
      applyAnnouncementBar('scroll', '');
      return;
    }
    const data = await resp.json();
    
    // Store settings in a local object to process sequentially
    const settings = {};
    data.forEach(row => {
      settings[row.key] = row.value;
    });

    // 0. product-card CTA mode (Add-to-Bag vs color swatches)
    if (settings.product_card_cta !== undefined) {
      let cta = settings.product_card_cta;
      try { if (typeof cta === 'string') cta = JSON.parse(cta); } catch (_) {}
      window.__zwApplyCardMode((cta && cta.mode === 'color-swatches') ? 'color-swatches' : 'add-to-bag');
    }

    // 1. brand
    if (settings.brand !== undefined) {
      let b = settings.brand;
      try { if (typeof b === 'string') b = JSON.parse(b); } catch(e){}
      if (b && b.favicon) {
        let link = document.querySelector('link[rel="icon"]');
        if (!link) {
          link = document.createElement('link');
          link.rel = 'icon';
          document.head.appendChild(link);
        }
        window.__zwApplyFavicon ? window.__zwApplyFavicon(b.favicon) : (link.href = b.favicon);
      }
      try { localStorage.setItem('zw-brand', JSON.stringify(b || {})); } catch (e) {}
      if (b && b.admin_res_bg) document.documentElement.style.setProperty('--admin-res-bg', b.admin_res_bg);
      if (b && b.admin_res_text) document.documentElement.style.setProperty('--admin-res-text', b.admin_res_text);
    }

    // 2. page_builder_published (or draft page_builder if previewing)
    const isPreview = new URLSearchParams(window.location.search).get('builder') === '1';
    if (isPreview) {
      if (settings.page_builder !== undefined) {
        const val = typeof settings.page_builder === 'string' ? JSON.parse(settings.page_builder) : settings.page_builder;
        if (val && val.sections) {
          window.__zwApplyBuilderConfig(val);
          window.__zwPageBuilderActive = true;
        }
      }
    } else if (settings.page_builder_published !== undefined) {
      const val = typeof settings.page_builder_published === 'string' ? JSON.parse(settings.page_builder_published) : settings.page_builder_published;
      if (val && val.sections && val.sections.some(s => s.visible !== false)) {
        // Merge builder_theme into themeSettings for bar colors etc. if not in published data
        if (!val.themeSettings && settings.builder_theme) {
          try {
            val.themeSettings = typeof settings.builder_theme === 'string' ? JSON.parse(settings.builder_theme) : settings.builder_theme;
          } catch(_) {}
        }
        // Fall back to themeSettings.default_mode if theme wasn't saved in older publishes
        if (!val.theme) {
          const bt = val.themeSettings;
          if (bt && bt.default_mode) val.theme = bt.default_mode;
        }
        window.__zwApplyBuilderConfig(val);
        window.__zwPageBuilderActive = true;
        const themeMode = val.theme === 'light' ? 'light' : val.theme === 'super-light' ? 'super-light' : 'dark';
        try { localStorage.setItem('zw_homepage_theme_mode', themeMode); } catch(e) {}
      }
    }

    // 3. theme — site_settings.theme (the admin appearance toggle) is the source
    // of truth for the homepage theme and OVERRIDES any theme baked into the
    // published page-builder config. Previously this was skipped whenever a
    // page-builder layout was published (__zwPageBuilderActive), which locked the
    // homepage to the layout's saved theme and made the admin Dark/Light toggle
    // appear to do nothing. Still skipped in the live builder preview, where the
    // builder's own theme buttons drive the preview.
    if (settings.theme !== undefined && !window.__ZW_BUILDER_PREVIEW__) {
        const mode = settings.theme && settings.theme.mode === 'dark' ? 'dark' : settings.theme && settings.theme.mode === 'super-light' ? 'super-light' : 'light';
        if (window.__zwApplyAdminTheme) window.__zwApplyAdminTheme(mode);
        else {
          document.body.classList.toggle('light-mode', mode === 'light' || mode === 'super-light');
          document.body.classList.toggle('super-light-mode', mode === 'super-light');
          if (window.__zwSyncThemeColor) window.__zwSyncThemeColor();
        }
        // Persist the resolved mode so the synchronous <head> flash-prevention
        // script (which reads zw_homepage_theme_mode || zw_theme_mode before first
        // paint) renders the correct background on the NEXT load — no dark flash.
        // Previously this key was REMOVED whenever the homepage wasn't page-builder
        // driven, which is exactly why an admin-set light theme flashed dark on
        // every refresh. Cache both keys so every page (home + the rest) is covered.
        try {
          localStorage.setItem('zw_homepage_theme_mode', mode);
          localStorage.setItem('zw_theme_mode', mode);
        } catch(e) {}
    }

    // 4. hero
    if (settings.hero !== undefined) {
      if (!window.__ZW_BUILDER_PREVIEW__ && !window.__zwPageBuilderActive) {
        const h = typeof settings.hero === 'string' ? JSON.parse(settings.hero) : settings.hero;
        if (h.kicker) {
          const el = document.querySelector('.hero-kicker');
          if (el) el.textContent = h.kicker;
        }
        if (h.heading) {
          const el = document.querySelector('.hero-h1');
          if (el) el.textContent = h.heading;
        }
        if (h.subtext) {
          const el = document.querySelector('.hero-sub');
          if (el) el.textContent = h.subtext;
        }
        if (h.cta_text) {
          const el = document.querySelector('.hero-cta-row .btn-outline');
          if (el) {
            const svg = el.querySelector('svg');
            el.textContent = h.cta_text;
            if (svg) el.appendChild(svg);
          }
        }
        if (h.image) {
          const el = document.getElementById('hero-image');
          if (el) el.src = h.image;
          const mobileSource = document.getElementById('hero-mobile-source');
          if (mobileSource) mobileSource.srcset = h.image;
          window.__ZW_HERO_IMAGE = h.image;
          try { localStorage.setItem('zw-hero-image', h.image); } catch (e) {}
          const preload = document.getElementById('hero-preload');
          if (preload) preload.href = h.image;
        }
      }
    }

    // 5. announcement_bar
    let announcementApplied = false;
    if (settings.announcement_bar !== undefined) {
      let v = settings.announcement_bar;
      try {
        if (typeof v === 'string') v = JSON.parse(v);
      } catch(e) {}
      
      let mode = 'scroll';
      let msgText = '';
      if (typeof v === 'object' && v !== null) {
        mode = v.mode || (v.enabled === false ? 'off' : 'scroll');
        msgText = Object.prototype.hasOwnProperty.call(v, 'main') ? (v.main ?? '') : '';
      } else {
        msgText = v;
      }

      applyAnnouncementBar(mode, msgText);
      announcementApplied = true;
    }
    if (!announcementApplied) applyAnnouncementBar('scroll', '');

    // Apply builder_theme overrides to bar bg/color â€” only when builder is NOT active
    // (when active, themeSettings are already merged into the published config above)
    if (!window.__zwPageBuilderActive && settings.builder_theme) {
      try {
        const bt = typeof settings.builder_theme === 'string' ? JSON.parse(settings.builder_theme) : settings.builder_theme;
        const bar = document.getElementById('bar');
        if (bar) {
          if (bt.bar_bg) bar.style.setProperty('background', bt.bar_bg, 'important');
          if (bt.bar_text_color) bar.style.setProperty('color', bt.bar_text_color, 'important');
        }
        if (bt.accent_color) {
          document.documentElement.style.setProperty('--gold', bt.accent_color);
          document.documentElement.style.setProperty('--zw-accent', bt.accent_color);
        }
      } catch(_) {}
    }

    // 6. shipping_policy
    if (settings.shipping_policy !== undefined) {
      const v = settings.shipping_policy || {};
      window._shippingPolicy = {
        enabled:      v.free_shipping_enabled !== false,
        threshold:    parseFloat(v.free_threshold)  || 100,
        standardRate: parseFloat(v.standard_rate)   || 8,
      };
      // Re-render cart with real policy now that settings have loaded.
      // (Was updateCartSummary() — which never existed, so this threw and the
      // catch below re-applied the announcement bar as hardcoded 'scroll',
      // clobbering the saved mode. The cart renderer is renderCart().)
      const cart = JSON.parse(localStorage.getItem('cart') || '[]');
      const sub  = cart.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
      if (sub > 0) renderCart();
    }

    // 7. fonts â€” apply via storefront-theme.js helper (avoids duplicate Supabase fetch)
    if (settings.fonts && window.__zwApplyThemeRows) {
      window.__zwApplyThemeRows([{ key: 'fonts', value: settings.fonts }]);
    }

    // If in builder preview, re-apply builder config now that Supabase is done
    if (window.__zwReapplyBuilder) window.__zwReapplyBuilder();
  } catch (e) {
    console.log('Settings load skipped:', e);
    applyAnnouncementBar('scroll', '');
    if (window.__zwReapplyBuilder) window.__zwReapplyBuilder();
  }
})();

let _user = null, _favs = [];

// Pre-read the Supabase session from localStorage so the first renderCart()
// (and any member-priced product render) uses the correct member/guest pricing
// with no flash before the async getSession() below resolves. getSession()
// silently refreshes an expired access token when a refresh_token exists, so a
// session counts as logged-in if it has a user AND (a live access token OR a
// refresh_token). This is the same guard the bag page uses.
try {
  // Our supabase client is created with storageKey:'zuwera-auth' (see
  // supabase-client.js), NOT the default sb-<ref>-auth-token — match both.
  // The value comes in several shapes: raw JSON, a modern "base64-"-prefixed
  // value, or chunked .0/.1/... keys, optionally wrapped in {currentSession}.
  // Reassemble + decode all of them, otherwise the session reads as "guest"
  // and member prices flash in.
  let _base = null; const _chunks = {};
  for (let _i = 0; _i < localStorage.length; _i++) {
    const _k = localStorage.key(_i);
    if (!_k) continue;
    const _mm = _k.match(/^(?:zuwera-auth|sb-[a-z0-9-]+-auth-token)(?:\.(\d+))?$/);
    if (!_mm) continue;
    if (_mm[1] === undefined) _base = localStorage.getItem(_k);
    else _chunks[_mm[1]] = localStorage.getItem(_k);
  }
  const _order = Object.keys(_chunks).map(Number).sort((a, b) => a - b);
  let _rawStr = _order.length ? _order.map((n) => _chunks[n]).join('') : _base;
  if (_rawStr) {
    if (_rawStr.indexOf('base64-') === 0) {
      const _bb = _rawStr.slice(7).replace(/-/g, '+').replace(/_/g, '/');
      const _bin = atob(_bb);
      _rawStr = new TextDecoder().decode(Uint8Array.from(_bin, (c) => c.charCodeAt(0)));
    }
    const _raw = JSON.parse(_rawStr);
    const _sess = _raw && _raw.currentSession ? _raw.currentSession : _raw;
    if (_sess && _sess.user) {
      const _live = Number(_sess.expires_at || 0) * 1000 > Date.now();
      if (_live || _sess.refresh_token) _user = _sess.user;
    }
  }
} catch (_) {}

function isSignedInMember() {
  return !!_user;
}

function getRegularListPrice(product) {
  return parseFloat(product?.current_price ?? product?.price ?? 0) || 0;
}

function getMemberListPrice(product) {
  return parseFloat(product?.member_price ?? 0) || 0;
}

function getEffectiveListPrice(product) {
  const regular = getRegularListPrice(product);
  const member = getMemberListPrice(product);
  if (isSignedInMember() && member > 0 && (!regular || member < regular)) {
    return member;
  }
  return regular;
}

function getHomeProductPriceSnapshot(productId) {
  try {
    const cached = JSON.parse(sessionStorage.getItem('zw_home_products') || '[]');
    const matched = Array.isArray(cached) ? cached.find(product => product?.id === productId) : null;
    if (!matched) return null;
    return {
      regularPrice: getRegularListPrice(matched),
      memberPrice: getMemberListPrice(matched),
    };
  } catch {
    return null;
  }
}

function normalizeCartPricing(cart) {
  const sourceCart = Array.isArray(cart) ? cart : [];
  const normalized = sourceCart.map((item) => {
    const snapshot = item?.productId ? getHomeProductPriceSnapshot(item.productId) : null;
    const regularPrice = parseFloat(item?.regularPrice ?? item?.basePrice ?? snapshot?.regularPrice ?? item?.price ?? 0) || 0;
    const memberPrice = parseFloat(item?.memberPrice ?? item?.member_price ?? snapshot?.memberPrice ?? 0) || 0;
    const effectivePrice = (isSignedInMember() && memberPrice > 0 && (!regularPrice || memberPrice < regularPrice))
      ? memberPrice
      : regularPrice;

    return {
      ...item,
      regularPrice,
      memberPrice,
      price: effectivePrice || regularPrice || (parseFloat(item?.price) || 0),
    };
  });

  if (JSON.stringify(normalized) !== JSON.stringify(sourceCart)) {
    localStorage.setItem('cart', JSON.stringify(normalized));
  }

  return normalized;
}

if (_sb?.auth?.getSession) {
  Promise.race([
    _sb.auth.getSession(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('session timeout')), 5000))
  ])
    .then(({ data }) => {
      _user = data?.session?.user ?? null;
      updateNav();
      if (_user) {
        void loadFavs();
      } else {
        _favs = [];
        refreshHearts();
        refreshCartFavs();
      }
      renderCart();
      loadProducts();
    })
    .catch(() => {
      updateNav();
      refreshCartFavs();
      loadProducts();
    });
} else {
  // Defer to microtask so const declarations below (cartItems, etc.) are initialised first
  Promise.resolve().then(() => {
    updateNav();
    refreshCartFavs();
    renderCart();
    loadProducts();
  });
}

/* ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ LOAD PRODUCTS FROM SUPABASE ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ */
function productSlug(title) {
  if (!title) return '';
  return title.replace(/^zuwera\s+/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function productHref(product) {
  const slug = productSlug(product?.title || product?.name || product?.slug || '');
  const params = new URLSearchParams();
  if (product?.id) params.set('id', product.id);
  if (product?.sku) params.set('sku', product.sku);
  const qs = params.toString();
  if (slug) return `/product/${slug}${qs ? `?${qs}` : ''}`;
  return `/product${qs ? `?${qs}` : ''}`;
}

function normalizeCategoryLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function categoryLabelFromProduct(product) {
  return normalizeCategoryLabel(product?.subtitle || 'Jackets') || 'Jackets';
}

function categoryHref(category) {
  const label = normalizeCategoryLabel(category) || 'Jackets';
  return `drop001.html?category=${encodeURIComponent(label)}`;
}

function collectCategoryLabels(products) {
  const seen = new Set();
  const labels = [];
  (Array.isArray(products) ? products : []).forEach(product => {
    const label = categoryLabelFromProduct(product);
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(label);
  });
  return labels.length ? labels : ['Jackets'];
}

function renderCategoryNavigation(products) {
  if (window.__zwCustomNavApplied) return;
  const labels = collectCategoryLabels(products);
  const desktop = document.getElementById('nav-category-links');
  const mobile = document.getElementById('mobile-category-links');
  const desktopHtml = labels.map(label => `<a href="${categoryHref(label)}" class="nav-link">${label}</a>`).join('');
  const mobilePrimaryHtml = [
    ...labels.map(label => `<a href="${categoryHref(label)}" class="mobile-nav-link zw-mobile-primary-link">${label}</a>`),
    '<a href="index.html#about" class="mobile-nav-link zw-mobile-primary-link">About</a>'
  ].join('');
  if (desktop) desktop.innerHTML = desktopHtml;
  if (mobile) mobile.innerHTML = mobilePrimaryHtml;
}

// Deduplication guard — if loadProducts() is called concurrently (e.g. from
// auth init and applyBuilderConfig at the same time) only one fetch runs.
// The early-fetch response body can only be read once, so concurrent calls
// hitting it simultaneously caused "body stream already read" errors.
let _loadProductsInFlight = null;

// Lightweight re-render from sessionStorage cache — no fetch, no skeleton.
// Used by onAuthStateChange so switching tabs doesn't flash.
function reRenderProductsFromCache() {
  const grid = document.getElementById('products-grid');
  if (!grid) return false;
  try {
    const cached = JSON.parse(sessionStorage.getItem('zw_home_products') || '[]');
    if (!Array.isArray(cached) || cached.length === 0) return false;
    renderProductCards(cached, grid);
    return true;
  } catch (_) {
    return false;
  }
}

async function loadProducts() {
  if (_loadProductsInFlight) {
    // A fetch is already in progress — wait for it to finish, then re-render.
    await _loadProductsInFlight.catch(() => {});
    return;
  }
  _loadProductsInFlight = _doLoadProducts();
  try {
    await _loadProductsInFlight;
  } finally {
    _loadProductsInFlight = null;
  }
}

async function _doLoadProducts() {
  const grid = document.getElementById('products-grid');
  if (!grid) return;

  // If we already have cached products, render them instantly (no skeleton
  // flash). The fetch below will still run and silently update if data changed.
  let usedCache = false;
  try {
    const cached = JSON.parse(sessionStorage.getItem('zw_home_products') || '[]');
    if (Array.isArray(cached) && cached.length > 0) {
      renderCategoryNavigation(cached);
      renderProductCards(cached, grid);
      usedCache = true;
    }
  } catch (_) {}

  // Show skeleton placeholders only on first visit (no cache yet).
  if (!usedCache) {
    grid.innerHTML = Array(4).fill(0).map(() => `
      <div class="pcard pcard--skeleton" aria-hidden="true" tabindex="-1">
        <div class="pcard-img"><div class="pcard-skel-img"></div></div>
        <div class="pcard-info">
          <div class="pcard-skel-line" style="width:38%;height:.52rem;margin-bottom:.55rem"></div>
          <div class="pcard-skel-line" style="width:82%;height:.9rem;margin-bottom:.45rem"></div>
          <div class="pcard-skel-line" style="width:26%;height:.68rem;margin-top:.9rem"></div>
        </div>
      </div>`).join('');
  }

  try {
    const headers = { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` };
    const fetchOpts = { headers, cache: 'no-store' };
    // Consume the early-fetch response exactly once, then clear it immediately
    // so any concurrent/subsequent call does a fresh fetch instead.
    const earlyFetch = window.__zwProductsEarlyFetch;
    window.__zwProductsEarlyFetch = null;
    const _timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000));
    const productsResp = await Promise.race([
      earlyFetch || fetch(
        `${SUPABASE_URL}/rest/v1/products?select=*,product_images(*),color_variants(*)&status=neq.Legacy&status=neq.Draft&order=sort_order.asc`,
        fetchOpts
      ),
      _timeout
    ]);
    if (!productsResp.ok) throw new Error(`HTTP ${productsResp.status}`);
    let products = await productsResp.json();
    if (!Array.isArray(products)) products = [];
    
    const normalizedProducts = products.map((product) => ({
      ...product,
      product_images: (product.product_images || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    }));
    // Only re-render if data actually changed (avoids a DOM thrash when
    // returning to the tab with unchanged products).
    const prevCache = sessionStorage.getItem('zw_home_products');
    const newCache = JSON.stringify(normalizedProducts);
    sessionStorage.setItem('zw_home_products', newCache);
    if (!usedCache || newCache !== prevCache) {
      if (normalizedProducts.length === 0) {
        grid.innerHTML = '<div class="pcard" style="opacity:.3;text-align:center;padding:3rem">No products yet.</div>';
      } else {
        renderCategoryNavigation(normalizedProducts);
        renderProductCards(normalizedProducts, grid);
      }
    }
  } catch(e) {
    console.error('loadProducts error:', e);
    // If we already showed cached products, leave them visible instead of
    // replacing with an error message — the user still has a working page.
    if (usedCache) return;
    // Actionable, not a dead end: offer a retry. The early fetch is cleared
    // first so the retry issues a fresh request instead of re-awaiting the
    // same rejected promise.
    grid.innerHTML = '<div class="pcard" style="opacity:.6;text-align:center;padding:3rem">' +
      '<p style="margin-bottom:1rem">Could not load products.</p>' +
      '<button type="button" class="btn-outline" style="cursor:pointer" ' +
      'onclick="window.__zwProductsEarlyFetch=null;this.disabled=true;this.textContent=\'Retrying…\';loadProducts()">Retry</button>' +
      '</div>';
  }
}

// Standalone review-summary loader — uses direct REST (no _sb dependency,
// Batch review loader — one request for all cards instead of N separate fetches.
// Falls back to a per-card fetch for the legacy loadCardReviewSummary(pid, domId) call signature.
// Shared review-summary helpers (used by both initial render and the async loader,
// and cached in sessionStorage so a reviewed card shows the right count immediately
// on the next render instead of flashing the "Be the first to review" placeholder).
function zwStarsMarkup(avg) {
  const full = Math.round(avg);
  return `<span style="color:#F891A5" aria-hidden="true">${'★'.repeat(full)}</span>` +
    `<span style="color:rgba(244,241,235,.15)" aria-hidden="true">${'★'.repeat(5 - full)}</span>` +
    `<span class="sr-only">${avg.toFixed(1)} out of 5 stars</span>`;
}
function zwReviewCountText(count, avg) {
  return count > 0 ? `${count} review${count !== 1 ? 's' : ''} · ${avg.toFixed(1)}` : 'Be the first to review';
}
function zwReadRevCache() { try { return JSON.parse(sessionStorage.getItem('zw_rev_sum') || '{}') || {}; } catch (_) { return {}; } }
function zwWriteRevCache(map) { try { sessionStorage.setItem('zw_rev_sum', JSON.stringify(map)); } catch (_) {} }
function zwApplyCardReview(domId, count, avg) {
  const avgEl = document.getElementById(`avg-${domId}`);
  const cntEl = document.getElementById(`cnt-${domId}`);
  if (cntEl) cntEl.textContent = zwReviewCountText(count, avg);
  if (avgEl) {
    if (count > 0) { avgEl.innerHTML = zwStarsMarkup(avg); avgEl.style.display = ''; }
    else { avgEl.innerHTML = ''; avgEl.style.display = 'none'; }
  }
}

async function loadAllCardReviewSummaries(cardMap) {
  // cardMap: { [pid]: domId }
  const pids = Object.keys(cardMap);
  if (!pids.length) return;
  try {
    const idList = pids.map(id => `"${id}"`).join(',');
    const resp = await Promise.race([
      fetch(
        `${SUPABASE_URL}/rest/v1/reviews?product_id=in.(${pids.join(',')})&select=product_id,rating`,
        { headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` } }
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('review timeout')), 6000))
    ]);
    if (!resp.ok) return;
    const rows = await resp.json();
    if (!Array.isArray(rows)) return;
    // Group by product_id
    const groups = {};
    rows.forEach(r => {
      if (!r.product_id) return;
      groups[r.product_id] = groups[r.product_id] || [];
      groups[r.product_id].push(r.rating);
    });
    const cache = zwReadRevCache();
    // Resolve EVERY card (not only reviewed ones): zero-review products settle on
    // "Be the first to review" and reviewed products get their count \u2014 so neither
    // is left showing a stale placeholder. Cache for instant-correct re-renders.
    pids.forEach(pid => {
      const domId = cardMap[pid];
      if (!domId) return;
      const ratings = groups[pid] || [];
      const count = ratings.length;
      const avg = count ? ratings.reduce((s, r) => s + r, 0) / count : 0;
      zwApplyCardReview(domId, count, avg);
      cache[pid] = { count, avg };
    });
    zwWriteRevCache(cache);
  } catch(e) { console.error('Review summary error:', e); }
}
// Keep the per-card function for any existing call sites outside renderProductCards
async function loadCardReviewSummary(pid, domId) {
  await loadAllCardReviewSummaries({ [pid]: domId });
}

// Build a row of square color swatches for a product card (Nike-style). Each
// swatch carries its color's primary image so hovering can swap the card photo;
// clicking opens the add-to-bag modal preselected to that color. Returns '' when
// the product has no color variants (the card then keeps its Add-to-Bag button).
function zwCardSwatchRow(p, quickAddPayload, fallbackImg) {
  const colors = (p.color_variants || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const imgs = p.product_images || [];
  const esc = (s) => escapeHomeFavoriteHtml(String(s == null ? '' : s));
  const MAX = 5;
  if (!colors.length) {
    // Single-image product: show one thumbnail of the main image so the card
    // stays consistent (no out-of-place Add-to-Bag button).
    let src = fallbackImg || '';
    if (src && typeof window.optimizeImage === 'function') src = window.optimizeImage(src, 600);
    if (!src) return '';
    return `<div class="zw-card-swatches" data-quick-add="${quickAddPayload}"><button type="button" class="zw-card-swatch" data-img="${esc(src)}" aria-label="${esc(p.title || 'View')}" style="background-image:url('${esc(src)}')"></button></div>`;
  }
  // Cap at MAX thumbnails + a "+N" overflow tile so every card is the same height.
  let html = colors.slice(0, MAX).map((c) => {
    const ci = imgs.filter((im) => im.color_variant_id === c.id).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))[0];
    let src = (ci && ci.image_url) || fallbackImg || '';
    if (src && typeof window.optimizeImage === 'function') src = window.optimizeImage(src, 600);
    const nm = c.color_name || 'Color';
    const thumbStyle = src ? `background-image:url('${esc(src)}')` : `background:${esc(c.hex_color || '#888')}`;
    return `<button type="button" class="zw-card-swatch" data-color-name="${esc(nm)}" data-img="${esc(src)}" title="${esc(nm)}" aria-label="${esc(nm)}" style="${thumbStyle}"></button>`;
  }).join('');
  if (colors.length > MAX) html += `<button type="button" class="zw-card-swatch zw-swatch-more" aria-label="${esc((colors.length - MAX) + ' more colors')}">+${colors.length - MAX}</button>`;
  return `<div class="zw-card-swatches" data-quick-add="${quickAddPayload}">${html}</div>`;
}

function renderProductCards(products, grid) {
  let renderList = products.filter(p => {
    const s = (p.status || '').toLowerCase();
    return s !== 'legacy' && s !== 'draft';
  });
  // If only 1 product, show its different images as separate cards — but not when
  // it has color variants (that split strips the per-color images the swatches need).
  if (products.length === 1 && products[0].product_images && products[0].product_images.length > 1
      && !(products[0].color_variants && products[0].color_variants.length)) {
    const p = products[0];
    let allImages = [...p.product_images].sort((a, b) => a.sort_order - b.sort_order);
    if (p.image_url && !allImages.some(img => img.image_url === p.image_url)) {
      allImages.unshift({ image_url: p.image_url, sort_order: -1 });
    }
      renderList = allImages.slice(0, 2).map((img, idx) => ({
      ...p,
      image_url: img.image_url,
        product_images: [img], // force this image to be the primary one for this card
        unique_id: `${p.id}-${idx}`
    }));
  }

  grid.classList.remove('single-item', 'two-items');
  if (renderList.length === 1) {
    grid.classList.add('single-item');
  } else if (renderList.length === 2) {
    grid.classList.add('two-items');
  }

  const _revCache = zwReadRevCache();
  grid.innerHTML = renderList.map(p => {
    const productName = p.title || p.name || 'Untitled';
    const productCategory = categoryLabelFromProduct(p);
    const _g = String(p.gender || '').trim().toLowerCase();
    const _genderPrefix = _g === 'men' ? "Men's " : _g === 'women' ? "Women's " : _g === 'unisex' ? 'Unisex ' : _g === 'kids' ? "Kids' " : '';
    const productType = (_genderPrefix + (productCategory || '')).trim();
    const productPrice = getEffectiveListPrice(p) || parseFloat(p.msrp || 0) || parseFloat(p.price || 0) || 0;
    const badge = (p.status === 'coming_soon' || p.status === 'Coming Soon') ? 'Coming Soon' : (p.status === 'live' || p.status === 'Live' ? 'Available' : (p.status || 'Coming Soon'));
    let firstImg = p.image_url;
    if (p.product_images && p.product_images.length > 0) {
      p.product_images.sort((a, b) => a.sort_order - b.sort_order);
      if (p.product_images[0].image_url) firstImg = p.product_images[0].image_url;
    }
    const _cardImgSrc = firstImg && typeof window.optimizeImage === 'function' ? window.optimizeImage(firstImg, 600) : firstImg;
    const imgHtml = firstImg
      ? `<img src="${_cardImgSrc}" alt="${productName}" loading="lazy" style="width:100%;height:100%;object-fit:cover;object-position:top center">`
      : `<div class="pcard-img-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M3 9l2-5h4l1 3h4l1-3h4l2 5v11H3V9z"/></svg>
            <p>Image Coming Soon</p>
          </div>`;
    const priceDisplay = productPrice ? `$${Number(productPrice).toFixed(2)}` : 'Price TBA';
    const domId = p.unique_id || p.id;
    const isLive = (p.status === 'live' || p.status === 'Live');
    // Cards that render a swatch row get .pcard--swatched so swatch mode can hide
    // their Add-to-Bag button via a plain class selector (no :has() reliance).
    const hasSwatches = isLive && ((p.color_variants || []).length > 0 || !!firstImg);
    const quickAddPayload = encodeURIComponent(JSON.stringify({
      productId: p.id,
      title: productName,
      price: Number(productPrice) || 0,
      regularPrice: getRegularListPrice(p),
      memberPrice: getMemberListPrice(p),
      sku: p.sku || '',
      image: firstImg || '',
      weightLb: parseFloat(p.shipping_weight_lb) || 0.5,
      imageFocalY: p.image_focal_y ?? 50
    }));
    return `
      <div class="pcard${hasSwatches ? ' pcard--swatched' : ''}" onclick="if(!event.target.closest('.quick-size-panel,.pcard-add-btn,.zw-card-swatches')){window.location.href='${productHref(p)}'}" style="cursor:pointer;position:relative;overflow:hidden">
        <div class="pcard-img">
          ${imgHtml}
          <div class="pcard-badge">${escapeHomeFavoriteHtml(badge)}</div>
          <button class="heart-btn" onclick="event.stopPropagation()" data-product-id="${p.id}" data-product-name="${escapeHomeFavoriteHtml(productName)}" data-price="${priceDisplay}" data-product-image="${firstImg || ''}" aria-label="Save">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>
        <div class="pcard-info">
          <p class="pcard-name">${escapeHomeFavoriteHtml(productName)}</p>
          <p class="pcard-cat">${escapeHomeFavoriteHtml(productType)}</p>
          <p class="pcard-price">${priceDisplay}</p>
          <button class="pcard-action" onclick="event.stopPropagation();openAllReviewsModal('${p.id}', '${domId}', this.dataset.pname)" data-review-pid="${p.id}" data-review-domid="${domId}" data-pname="${escapeHomeFavoriteHtml(productName)}">
            <span id="avg-${domId}" style="${_revCache[p.id] && _revCache[p.id].count > 0 ? '' : 'display:none'}">${_revCache[p.id] && _revCache[p.id].count > 0 ? zwStarsMarkup(_revCache[p.id].avg) : ''}</span>
            <span id="cnt-${domId}">${_revCache[p.id] ? zwReviewCountText(_revCache[p.id].count, _revCache[p.id].avg) : ''}</span>
          </button>
          ${isLive && window.innerWidth > 900 ? `<button type="button" class="pcard-add-btn" data-quick-add="${quickAddPayload}"><span class="pcard-add-desktop-label">Add to Bag</span></button>` : ''}
          ${hasSwatches ? zwCardSwatchRow(p, quickAddPayload, firstImg) : ''}
        </div>
        ${isLive ? `<div class="quick-size-panel" id="qsp-${domId}">
          <div class="quick-size-panel-header">
            <span id="qsp-label-${domId}">Select Colorway</span>
            <button class="quick-size-close" onclick="event.stopPropagation();closeQuickSizePanel('qsp-${domId}')">âœ•</button>
          </div>
          <div id="qsp-body-${domId}">
            <div class="quick-color-row" id="qsc-${domId}"></div>
            <div class="quick-color-name" id="qscn-${domId}"></div>
          </div>
        </div>` : ''}
      </div>`;
  }).join('');

  // Re-init hearts for dynamically loaded cards
  if (typeof refreshHearts === 'function') refreshHearts();
  // Load all review summaries in ONE batched request instead of N separate fetches
  const _reviewCardMap = {};
  renderList.forEach(p => { _reviewCardMap[p.id] = p.unique_id || p.id; });
  loadAllCardReviewSummaries(_reviewCardMap);
  // Re-bind heart button listeners
  document.querySelectorAll('.heart-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      if (typeof toggleFav === 'function') toggleFav(this);
    });
  });
}


function setDisabled(id, dis, label) {
  const b = document.getElementById(id);
  b.disabled = dis; b.textContent = dis ? label + '...' : label;
}

// Auth listener started in DOMContentLoaded (see _initAuth below)
function _initAuth() {
  if (!_sb) return;
  _sb.auth.onAuthStateChange((event, session) => {
    _user = session?.user ?? null;
    updateNav();
    if (event === 'SIGNED_IN') { closeAuth(); }
    if (event === 'PASSWORD_RECOVERY') { openAuth('update-password'); }
    if (_user) {
      void loadFavs();
      const expectedUserId = _user.id;
      setTimeout(async () => {
        try {
          const { data, error } = await _sb.auth.getUser();
          if (error || !data?.user || data.user.id !== expectedUserId) {
            await _sb.auth.signOut().catch(()=>{});
            localStorage.removeItem('zuwera-auth');
            _user = null;
            updateNav();
            _favs = [];
            refreshHearts();
            refreshCartFavs();
          }
        } catch (_) {}
      }, 0);
    } else { _favs = []; refreshHearts(); refreshCartFavs(); }
    renderCart();
    // Re-render from cache instead of full loadProducts() to avoid the
    // skeleton-flash when switching tabs (onAuthStateChange fires on
    // every INITIAL_SESSION which Supabase re-emits on tab refocus).
    if (!reRenderProductsFromCache()) loadProducts();
  });
}

function updateNav() {
  const li = document.getElementById('login-btn');
  const ac = document.getElementById('account-btn');
  const on = !!_user;
  li.style.display = on ? 'none' : '';
  if (on) { ac.classList.add('show'); }
  else { ac.classList.remove('show'); }
  if (on && _user) {
    const name = _user.user_metadata?.full_name || _user.email.split('@')[0];
    ac.textContent = name.split(' ')[0];
  }
}

/* AUTH MODAL */
let _authReturnModalId = null;
function setPageScrollLock(locked) {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;
  // Defer to the centralized modal-lock.js when present. This function is a
  // second position:fixed scroll lock; running it on top of modal-lock makes
  // whichever locks LAST read scrollY = 0 (the body is already pinned) and
  // overwrite the offset to top:0 — snapping the page to the top — and the two
  // unlocks then race and leave the body frozen. modal-lock owns the lock.
  if (window.ZWModalScrollLock) { window.ZWModalScrollLock.refresh(); return; }
  if (!window.__zwPageScrollState) {
    window.__zwPageScrollState = { locked: false, y: 0 };
  }
  const state = window.__zwPageScrollState;

  if (locked) {
    if (state.locked) return;
    state.locked = true;
    state.y = window.scrollY || window.pageYOffset || 0;
    const scrollbarGap = Math.max(0, window.innerWidth - root.clientWidth);
    root.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';
    body.style.position = 'fixed';
    body.style.setProperty('top', `-${state.y}px`, 'important');
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    if (scrollbarGap > 0) body.style.paddingRight = `${scrollbarGap}px`;
    return;
  }

  if (!state.locked) return;
  state.locked = false;
  const restoreY = state.y || 0;
  const prevScrollBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  root.style.overflow = '';
  root.style.overscrollBehavior = '';
  body.style.position = '';
  body.style.removeProperty('top');
  body.style.left = '';
  body.style.right = '';
  body.style.width = '';
  body.style.overflow = '';
  body.style.overscrollBehavior = '';
  body.style.paddingRight = '';
  try {
    window.scrollTo({ top: restoreY, left: 0, behavior: 'instant' });
  } catch (_) {
    window.scrollTo(0, restoreY);
  }
  requestAnimationFrame(() => { root.style.scrollBehavior = prevScrollBehavior; });
}
function openAuth(tab) {
  const cartModal = document.getElementById('cart-modal');
  _authReturnModalId = cartModal?.classList.contains('open') ? 'cart-modal' : null;
  if (_authReturnModalId) cartModal.classList.remove('open');
  document.getElementById('auth-modal').classList.add('open');
  setPageScrollLock(true);
  switchAuthTab(tab || 'signin');
}
function closeAuth() {
  document.getElementById('auth-modal').classList.remove('open');
  const shouldReturnToCart = _authReturnModalId === 'cart-modal';
  _authReturnModalId = null;
  if (shouldReturnToCart) {
    renderCart();
    document.getElementById('cart-modal')?.classList.add('open');
    setPageScrollLock(true);
    return;
  }
  setPageScrollLock(false);
}
window.__zwOpenAuth = function(tab) {
  openAuth(tab || 'signin');
  return false;
};
function switchAuthTab(t) {
  document.querySelectorAll('#auth-modal .atab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('#auth-modal .apanel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + t)?.classList.add('active');
          ['signin-error','signup-error','forgot-error','update-password-error'].forEach(id => { const e = document.getElementById(id); if(e) e.textContent = ''; });
  const fs = document.getElementById('forgot-success'); if(fs) fs.style.display = 'none';
  const ss = document.getElementById('signup-success'); if (ss) ss.style.display = 'none';
  const sb = document.getElementById('signup-submit'); if (sb) sb.style.display = 'block';
}
document.querySelectorAll('#auth-modal .atab').forEach(b => b.addEventListener('click', () => switchAuthTab(b.dataset.tab)));
document.getElementById('auth-modal-close').addEventListener('click', closeAuth);
document.getElementById('auth-modal').addEventListener('click', e => { if(e.target === e.currentTarget) closeAuth(); });
document.getElementById('login-btn').addEventListener('click', (e) => {
  e.preventDefault();
  window.__zwOpenAuth('signin');
});
document.getElementById('forgot-link').addEventListener('click', e => { e.preventDefault(); switchAuthTab('forgot'); });
document.getElementById('back-to-signin').addEventListener('click', e => { e.preventDefault(); switchAuthTab('signin'); });

const _urlParams = new URLSearchParams(window.location.search);
const _authAction = _urlParams.get('auth');
// Optional same-site path to return to after signing in (used by the account
// page's auth wall: /?auth=signin&next=%2Faccount.html). Sanitized: must be a
// site-relative path ("/x", not "//host" or an absolute URL).
const _authNextRaw = _urlParams.get('next') || '';
const _authNext = /^\/(?!\/)/.test(_authNextRaw) ? _authNextRaw : '';
if (_authAction === 'signin' || _authAction === 'signup') {
  setTimeout(() => { if (!_user) openAuth(_authAction); }, 100);
  window.history.replaceState({}, document.title, window.location.pathname);
}

/* TOGGLE PASSWORD VISIBILITY */
function togglePwd(id, btn) {
  const inp = document.getElementById(id);
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  } else {
    inp.type = 'password';
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  }
}

document.getElementById('signin-submit').addEventListener('click', async () => {
  const email = document.getElementById('signin-email').value.trim();
  const pass = document.getElementById('signin-password').value;
  const err = document.getElementById('signin-error');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Please fill in all fields.'; return; }
  setDisabled('signin-submit', true, 'Login');
  const runSignIn = async (captchaToken) => {
    if (_sb) {
      const signInOpts = captchaToken ? { captchaToken } : {};
      const { error } = await _sb.auth.signInWithPassword({ email, password: pass, options: signInOpts });
      if (error) {
        err.textContent = error.message === 'Email not confirmed' ? 'Please check your email and verify your account.' : error.message;
        setDisabled('signin-submit', false, 'Login');
        return;
      }
    }
    setDisabled('signin-submit', false, 'Login');
    closeAuth();
    showToast('Welcome back!');
    if (_authNext) { window.location.href = _authNext; return; }
  };
  await runSignIn(null);
});

document.getElementById('signup-submit').addEventListener('click', async () => {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pass = document.getElementById('signup-password').value;
  const err = document.getElementById('signup-error');
  const suc = document.getElementById('signup-success');
  err.textContent = '';
  if (suc) suc.style.display = 'none';
  if (!name || !email || !pass) { err.textContent = 'Please fill in all fields.'; return; }
  if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
  setDisabled('signup-submit', true, 'Create Account');
  const runSignUp = async (captchaToken) => {
    if (_sb) {
      const signUpOpts = {
        data: { full_name: name },
        emailRedirectTo: window.location.origin + '/confirm.html'
      };
      if (captchaToken) signUpOpts.captchaToken = captchaToken;
      const { data, error } = await _sb.auth.signUp({ email, password: pass, options: signUpOpts });
      if (error) {
        err.textContent = error.message;
        setDisabled('signup-submit', false, 'Create Account');
        return;
      }
      if (typeof gtag === 'function') gtag('event', 'sign_up', { method: 'Email' });
      if (window.zwPixel) zwPixel.completeRegistration('Email');
      setDisabled('signup-submit', false, 'Create Account');
      if (!data?.session) {
        if (suc) suc.style.display = 'block';
        document.getElementById('signup-submit').style.display = 'none';
        return;
      }
      closeAuth();
      showToast('Account created! Welcome to Zuwera.');
    }
  };
  await runSignUp(null);
});

document.getElementById('forgot-submit').addEventListener('click', async () => {
  const email = document.getElementById('forgot-email').value.trim();
  const err = document.getElementById('forgot-error'), suc = document.getElementById('forgot-success');
  err.textContent = ''; suc.style.display = 'none';
  if (!email) { err.textContent = 'Please enter your email.'; return; }
  setDisabled('forgot-submit', true, 'Send Reset Link');
  const runForgot = async (captchaToken) => {
    if (_sb) {
      const resetOpts = { redirectTo: window.location.origin + '/confirm.html' };
      if (captchaToken) resetOpts.captchaToken = captchaToken;
      const { error } = await _sb.auth.resetPasswordForEmail(email, resetOpts);
      if (error) {
        err.textContent = error.message;
        setDisabled('forgot-submit', false, 'Send Reset Link');
        return;
      }
    }
    setDisabled('forgot-submit', false, 'Send Reset Link');
    suc.style.display = 'block';
  };
  await runForgot(null);
});

document.getElementById('update-password-submit').addEventListener('click', async () => {
  const pass = document.getElementById('update-password-input').value;
  const err = document.getElementById('update-password-error');
  err.textContent = '';
  if (!pass || pass.length < 6) {
    err.textContent = 'Password must be at least 6 characters.';
    return;
  }
  setDisabled('update-password-submit', true, 'Update Password');
  if (_sb) {
    const { error } = await _sb.auth.updateUser({ password: pass });
    if (error) {
      err.textContent = error.message;
      setDisabled('update-password-submit', false, 'Update Password');
      return;
    }
  }
  setDisabled('update-password-submit', false, 'Update Password');
  closeAuth();
  showToast('Password updated. You can sign in now.');
});


/* ACCOUNT â€” navigate to dedicated page */
document.getElementById('account-modal-close').addEventListener('click', () => { document.getElementById('account-modal').classList.remove('open'); setPageScrollLock(false); });
document.getElementById('account-modal').addEventListener('click', e => { if(e.target===e.currentTarget) { document.getElementById('account-modal').classList.remove('open'); setPageScrollLock(false); } });
function switchAcctTab(t) {
  document.querySelectorAll('#account-modal .atab').forEach(b => b.classList.toggle('active', b.dataset.acctab === t));
  document.querySelectorAll('#account-modal .apanel').forEach(p => p.classList.remove('active'));
  document.getElementById('acct-panel-' + t)?.classList.add('active');
}
document.querySelectorAll('#account-modal .atab').forEach(b => b.addEventListener('click', () => {
  switchAcctTab(b.dataset.acctab);
  if(b.dataset.acctab === 'orders') loadOrders();
  if(b.dataset.acctab === 'favorites') renderAcctFavs();
}));
async function loadOrders() {
  if(!_sb || !_user) return;
  const loading = document.getElementById('orders-loading');
  const empty = document.getElementById('orders-empty');
  const list = document.getElementById('orders-list');
  loading.style.display = 'block'; empty.style.display = 'none'; list.innerHTML = '';
  const { data } = await _sb.from('orders').select('id,created_at,status').eq('user_id',_user.id).order('created_at',{ascending:false});
  loading.style.display = 'none';
  if(!data?.length){ empty.style.display = 'block'; return; }
  list.innerHTML = data.map(o => `<div style="padding:.9rem 0;border-bottom:1px solid rgba(244,241,235,.07);font-family:var(--fm);font-size:.68rem"><div style="letter-spacing:.1em">Order #${(o.id||'').slice(-8).toUpperCase()}</div><div style="opacity:.35;margin-top:.2rem">${new Date(o.created_at).toLocaleDateString()}</div><div style="opacity:.5;margin-top:.15rem">${o.status||'Confirmed'}</div></div>`).join('');
}
/* FAVORITES */
function applyHeartFill(btn, active) {
  btn.classList.toggle('active', active);
  btn.querySelectorAll('svg path, svg circle').forEach(el => {
    el.style.fill = active ? 'var(--red)' : '';
    el.style.stroke = active ? 'var(--red)' : '';
  });
}

function refreshHearts() {
  const ids = new Set(_favs.map(f => f.product_id));
  document.querySelectorAll('.heart-btn').forEach(b => applyHeartFill(b, ids.has(b.dataset.productId)));
}

const _homeFavoriteCache = new Map();

function escapeHomeFavoriteHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Allow only safe URL schemes for admin/CMS-supplied links: http(s), mailto, tel,
// root-relative ("/x", not "//host"), and #anchors. Blocks javascript:/data:/etc.
function zwSafeUrl(value) {
  const u = String(value == null ? '' : value).trim();
  if (!u) return '#';
  if (/^(?:#|\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(u)) return u;
  return '#';
}

function normalizeHomeFavoriteText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHomeFavoritePrice(value) {
  if (typeof value === 'string') {
    const parsed = parseFloat(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return parseFloat(value ?? 0) || 0;
}

function getHomeFavoritePrice(detail, fallbackPrice) {
  const regular = parseHomeFavoritePrice(detail?.current_price ?? fallbackPrice);
  const member = parseHomeFavoritePrice(detail?.member_price);
  if (_user && member > 0 && (!regular || member < regular)) return member;
  return regular;
}

function compareHomeFavoriteSizes(left, right) {
  const normalize = (value) => String(value || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rank = (value) => {
    const normalized = normalize(value);
    const direct = {
      'xxs': -20,
      'xs': -10,
      's': 0,
      's/m': 5,
      'm': 10,
      'm/l': 15,
      'l': 20,
      'l/xl': 25,
      'xl': 30,
      'xxl': 40,
      '2xl': 40,
      'xxxl': 50,
      '3xl': 50,
      'one size': 1000,
      'one size fits most': 1000
    };
    if (Object.prototype.hasOwnProperty.call(direct, normalized)) return direct[normalized];
    const numeric = normalized.match(/^(\d+)xl$/);
    if (numeric) return 30 + (parseInt(numeric[1], 10) * 10);
    return 500;
  };
  return rank(left) - rank(right);
}

function pickHomeFavoriteSize(sizeRows) {
  const rows = (Array.isArray(sizeRows) ? sizeRows : [])
    .map((row) => ({
      label: row?.size || row?.size_label || '',
      stock: Number(row?.stock_quantity ?? row?.stock ?? 0)
    }))
    .filter((row) => row.label);
  const inStock = rows.filter((row) => row.stock > 0);
  const source = inStock.length ? inStock : rows;
  if (!source.length) return '';
  source.sort((left, right) => compareHomeFavoriteSizes(left.label, right.label));
  return source[0]?.label || '';
}

function buildHomeFavoriteDetail(product, extra, favorite) {
  const images = Array.isArray(extra?.images) ? extra.images : [];
  const colors = Array.isArray(extra?.colors) ? extra.colors : [];
  const sizes = Array.isArray(extra?.sizes) ? extra.sizes : [];
  const detail = {
    id: product?.id || favorite?.product_id,
    title: product?.title || favorite?.product_name || 'Saved Item',
    subtitle: product?.subtitle || '',
    sku: product?.sku || '',
    image: images[0]?.image_url || product?.image_url || '',
    current_price: parseHomeFavoritePrice(product?.current_price ?? product?.price ?? favorite?.price),
    member_price: parseHomeFavoritePrice(product?.member_price),
    colorName: colors[0]?.color_name || product?.colorway || 'Standard',
    colors,
    sizes
  };
  detail.href = productHref({ id: detail.id, sku: detail.sku, title: detail.title });
  _homeFavoriteCache.set(String(detail.id || ''), detail);
  return detail;
}

async function getHomeFavoriteDetail(productId, favorite) {
  const normalizedProductId = String(productId || '');
  if (!normalizedProductId) return null;
  if (_homeFavoriteCache.has(normalizedProductId)) return _homeFavoriteCache.get(normalizedProductId);
  try {
    const cached = JSON.parse(sessionStorage.getItem('zw_home_products') || '[]');
    const matched = Array.isArray(cached) ? cached.find((product) => String(product?.id || '') === normalizedProductId) : null;
    if (matched) {
      return buildHomeFavoriteDetail(matched, {
        images: matched.product_images || [],
        colors: [],
        sizes: []
      }, favorite);
    }
  } catch {}

  try {
    const headers = { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` };
    const encodedId = encodeURIComponent(normalizedProductId);
    const [productResp, imagesResp, colorsResp, sizesResp] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/products?select=*&id=eq.${encodedId}&limit=1`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/product_images?select=*&product_id=eq.${encodedId}&order=sort_order.asc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/color_variants?select=*&product_id=eq.${encodedId}&order=sort_order.asc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/product_sizes?select=*&product_id=eq.${encodedId}`, { headers })
    ]);
    const productRows = productResp.ok ? await productResp.json() : [];
    const product = Array.isArray(productRows) ? productRows[0] : null;
    if (!product) return null;
    const images = imagesResp.ok ? await imagesResp.json() : [];
    const colors = colorsResp.ok ? await colorsResp.json() : [];
    const sizes = sizesResp.ok ? await sizesResp.json() : [];
    return buildHomeFavoriteDetail(product, { images, colors, sizes }, favorite);
  } catch {
    return null;
  }
}

function buildHomeFavoriteFallbackDetail(productId, favorite) {
  const snapshot = getHomeProductPriceSnapshot(productId) || null;
  const resolvedId = String(productId || favorite?.product_id || '');
  const title = favorite?.product_name || snapshot?.title || 'Saved Item';
  const regularPrice = parseHomeFavoritePrice(favorite?.price ?? snapshot?.regularPrice ?? snapshot?.price);
  return {
    id: resolvedId,
    title,
    subtitle: snapshot?.subtitle || snapshot?.category || '',
    sku: String(snapshot?.sku || ''),
    image: favorite?.product_image || snapshot?.image || snapshot?.image_url || '',
    current_price: regularPrice,
    member_price: parseHomeFavoritePrice(snapshot?.memberPrice),
    colorName: snapshot?.colorName || snapshot?.colorway || 'Standard',
    sizes: [],
    href: productHref({ id: resolvedId, sku: snapshot?.sku || '', title })
  };
}

const _homeFavoriteAddDedup = new Map();

function shouldSkipHomeFavoriteAdd(key, ttlMs = 700) {
  if (!key) return false;
  const now = Date.now();
  const last = _homeFavoriteAddDedup.get(key) || 0;
  if (last && (now - last) < ttlMs) return true;
  _homeFavoriteAddDedup.set(key, now);
  for (const [entryKey, ts] of _homeFavoriteAddDedup.entries()) {
    if ((now - ts) > ttlMs * 4) _homeFavoriteAddDedup.delete(entryKey);
  }
  return false;
}

function homeFavoriteCardHtml(favorite, detail, mode) {
  const productId = favorite.product_id;
  const name = detail?.title || favorite.product_name || 'Saved Item';
  const subtitleText = detail?.subtitle || '';
  const normalizedName = normalizeHomeFavoriteText(name);
  const normalizedSubtitle = normalizeHomeFavoriteText(subtitleText);
  const showSubtitle = !!subtitleText && normalizedSubtitle !== normalizedName;
  const subtitle = showSubtitle
    ? `<div style="font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:rgba(244,241,235,.35);margin-top:.2rem;">${escapeHomeFavoriteHtml(subtitleText)}</div>`
    : '';
  const colorName = detail?.colorName || '';
  const normalizedColor = normalizeHomeFavoriteText(colorName);
  const showColor = !!colorName && normalizedColor && normalizedColor !== 'standard' && normalizedColor !== normalizedName && normalizedColor !== normalizedSubtitle;
  const metaHtml = showColor
    ? `<div style="font-size:.68rem;color:rgba(244,241,235,.52);margin-top:.35rem;letter-spacing:.04em;">${escapeHomeFavoriteHtml(colorName)}</div>`
    : '';
  const imageHtml = detail?.image
    ? `<img src="${typeof window.optimizeImage === 'function' ? window.optimizeImage(detail.image, 180) : escapeHomeFavoriteHtml(detail.image)}" alt="${escapeHomeFavoriteHtml(name)}" loading="lazy" style="width:68px;height:86px;object-fit:cover;border:1px solid rgba(244,241,235,.08);flex-shrink:0;" data-fallback="${escapeHomeFavoriteHtml(detail.image)}" onerror="var f=this.dataset.fallback;if(f&&this.src!==f)this.src=f;">`
    : `<div style="width:68px;height:86px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(244,241,235,.08);color:rgba(244,241,235,.28);font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;flex-shrink:0;">No Image</div>`;
  const displayPrice = getHomeFavoritePrice(detail, favorite.price);
  const priceHtml = displayPrice > 0
    ? `<div style="font-size:.82rem;color:rgba(244,241,235,.72);margin-top:.45rem;">$${displayPrice.toFixed(2)}</div>`
    : '';
  const tag = mode === 'account' ? 'div' : 'li';
  const href = detail?.href || productHref({ id: productId, title: name });
  return `
    <${tag} style="display:flex;gap:.85rem;align-items:flex-start;padding:${mode === 'account' ? '.95rem 0' : '.75rem 0'};border-bottom:1px solid rgba(244,241,235,.07);">
      ${imageHtml}
      <div style="flex:1;min-width:0;">
        <div style="font-size:.88rem;line-height:1.35;">${escapeHomeFavoriteHtml(name)}</div>
        ${subtitle}
        ${metaHtml}
        ${priceHtml}
        <div class="zw-saved-item-actions">
          <a href="${href}" class="zw-saved-item-link zw-saved-item-btn zw-saved-item-btn--ghost">View Product</a>
          <button
            type="button"
            data-home-favorite-add="${escapeHomeFavoriteHtml(productId)}"
            class="zw-saved-item-btn zw-saved-item-btn--primary"
          >Add to Bag</button>
          <button
            type="button"
            data-home-favorite-remove="${escapeHomeFavoriteHtml(productId)}"
            class="zw-saved-item-btn zw-saved-item-btn--ghost"
          >Remove</button>
        </div>
      </div>
    </${tag}>
  `;
}

async function renderHomeFavoriteCollection(listEl, favorites, mode) {
  if (!listEl) return;
  const pairs = await Promise.all(favorites.map(async (favorite) => ({
    favorite,
    detail: await getHomeFavoriteDetail(favorite.product_id, favorite)
  })));
  listEl.innerHTML = pairs.map(({ favorite, detail }) => homeFavoriteCardHtml(favorite, detail, mode)).join('');
}

function _addHomeFavoriteWithSize(detail, size, favorite) {
  const regularPrice = parseHomeFavoritePrice(detail.current_price ?? favorite.price);
  const memberPrice  = parseHomeFavoritePrice(detail.member_price);
  const effectivePrice = getHomeFavoritePrice(detail, favorite.price);
  const cart = normalizeCartPricing(JSON.parse(localStorage.getItem('cart') || '[]'));
  const existing = cart.find((item) =>
    String(item.productId || '') === String(detail.id || '') &&
    String(item.size || '')      === String(size || '') &&
    String(item.colorName || '') === String(detail.colorName || 'Standard')
  );
  if (existing) { existing.quantity += 1; }
  else {
    cart.push({
      productId: detail.id, sku: detail.sku, title: detail.title, size,
      colorName: detail.colorName || 'Standard', regularPrice, memberPrice,
      price: effectivePrice || regularPrice, image: detail.image, quantity: 1
    });
  }
  localStorage.setItem('cart', JSON.stringify(cart));
  renderCart();
  if (typeof openCart === 'function') openCart();
  showToast(`Added ${detail.title}${size ? ` (${size})` : ''} to bag.`);
}

window.addHomeFavoriteToCart = async function(productId, btn) {
  const normalizedProductId = String(productId || '');
  if (shouldSkipHomeFavoriteAdd(`home-saved:${normalizedProductId}`)) return;
  const favorite = _favs.find((item) => String(item.product_id || '') === normalizedProductId) || { product_id: normalizedProductId };
  try {
    // Open the same quick-add modal used by the homepage product grid and
    // collection page. It handles size + color selection, so the user gets
    // the full picker rather than a stripped-down inline one.
    const price = parseHomeFavoritePrice(favorite.price) || 0;
    const image = favorite.product_image || '';
    const title = favorite.product_name || 'Product';
    window.quickAddToCart(normalizedProductId, title, price, '', image, 0.5, btn instanceof Element ? btn : null);
  } catch (error) {
    console.error('addHomeFavoriteToCart failed:', error);
    showToast('Could not add this saved item right now.');
  }
};

document.addEventListener('click', (event) => {
  if (event.defaultPrevented) return;
  const addButton = event.target.closest('[data-home-favorite-add]');
  if (addButton) {
    event.preventDefault();
    void window.addHomeFavoriteToCart(addButton.dataset.homeFavoriteAdd || '', addButton);
    return;
  }

  const removeButton = event.target.closest('[data-home-favorite-remove]');
  if (removeButton) {
    event.preventDefault();
    void removeFav(removeButton.dataset.homeFavoriteRemove || '', removeButton.closest('li, div'));
  }
});

function renderAcctFavs() {
  document.getElementById('acct-favs-loading').style.display = 'none';
  const empty = document.getElementById('acct-favs-empty');
  const list = document.getElementById('acct-favs-list');
  if(!_favs.length){ empty.style.display = 'block'; list.innerHTML=''; return; }
  empty.style.display = 'none';
  void renderHomeFavoriteCollection(list, _favs, 'account');
}

async function loadFavs() {
  if(!_sb || !_user) return;
  const { data } = await _sb.from('favorites').select('product_id,product_name,price,product_image').eq('user_id',_user.id);
  _favs = data || [];
  refreshHearts();
  void refreshCartFavs();
}

function pulseBagTarget() {
  const target = document.getElementById('cart-btn');
  if (!target) return;
  target.classList.remove('bag-dip');
  void target.offsetWidth;
  target.classList.add('bag-dip');
  const count = target.querySelector('.cc');
  if (count) {
    count.classList.remove('pop');
    void count.offsetWidth;
    count.classList.add('pop');
  }
  window.setTimeout(() => target.classList.remove('bag-dip'), 460);
}

function animateAddToBag(sourceEl, imageSrc) {
  // Add-to-bag acknowledgment: the bag icon "drop-in dip" (it dips and
  // squashes as if the item landed in it) plus the count-badge pop. The
  // (sourceEl, imageSrc) signature is kept so all call sites stay valid;
  // prefers-reduced-motion is honored in CSS.
  pulseBagTarget();
}

let _cartFavRenderVer = 0;
async function refreshCartFavs() {
  // The cart drawer (and its saved-items list) no longer exists on this page;
  // bag.html/auth.js own that UI now.
  if (!document.getElementById('cart-favs-list')) return;
  const myVer = ++_cartFavRenderVer;
  const out = document.getElementById('fav-logged-out-msg');
  const inn = document.getElementById('fav-logged-in-area');
  const empty = document.getElementById('cart-favs-empty');
  const list = document.getElementById('cart-favs-list');
  if(!_user){ if(out) out.style.display='block'; if(inn) inn.style.display='none'; return; }
  if(out) out.style.display='none'; if(inn) inn.style.display='block';
  if(!_favs.length){ if(empty) empty.style.display='block'; if(list) list.innerHTML=''; return; }
  if(empty) empty.style.display='none';
  // Snapshot current favs before async work starts
  const snapshot = [..._favs];
  try {
    const pairs = await Promise.all(snapshot.map(async (fav) => ({
      fav,
      detail: await getHomeFavoriteDetail(fav.product_id, fav)
    })));
    // If a newer render started while we were fetching, discard this result
    if (myVer !== _cartFavRenderVer) return;
    if (list) list.innerHTML = pairs.map(({ fav, detail }) => homeFavoriteCardHtml(fav, detail, 'cart')).join('');
  } catch(e) {
    console.error('refreshCartFavs failed:', e);
    if (myVer === _cartFavRenderVer && list) {
      list.innerHTML = '<div style="padding:1rem;text-align:center;opacity:.4;font-family:var(--fm);font-size:.7rem;">Could not load saved items.</div>';
    }
  }
}

async function toggleFav(btn) {
  if(!_user){ openAuth('signin'); return; }
  const pid = btn.dataset.productId, pname = btn.dataset.productName, price = btn.dataset.price;
  const pimage = btn.dataset.productImage || '';
  const isActive = _favs.some(f => f.product_id === pid);

  // Optimistic visual update â€” fires before DB round-trip
  if (!isActive) {
    _favs.push({ product_id:pid, product_name:pname, price, product_image:pimage });
    applyHeartFill(btn, true);
    const svgEl = btn.querySelector('svg');
    if (svgEl) {
      svgEl.classList.remove('heart-pop');
      void svgEl.offsetWidth;
      svgEl.classList.add('heart-pop');
      svgEl.addEventListener('animationend', () => svgEl.classList.remove('heart-pop'), { once: true });
    }
  } else {
    _favs = _favs.filter(f => f.product_id !== pid);
    applyHeartFill(btn, false);
  }

  btn.disabled = true;
  try {
    if (isActive) {
      await removeFav(pid, null, { silentToast:true });
      showToast('Removed from favorites.');
    } else {
      if(_sb) await _sb.from('favorites').upsert({ user_id:_user.id, product_id:pid, product_name:pname, price, product_image:pimage });
      void refreshCartFavs();
      showToast('Saved to favorites.');
    }
  } catch (error) {
    // Revert optimistic update on failure
    if (!isActive) { _favs = _favs.filter(f => f.product_id !== pid); applyHeartFill(btn, false); }
    else { _favs.push({ product_id:pid, product_name:pname, price, product_image:pimage }); applyHeartFill(btn, true); }
    console.error('toggleFav failed:', error);
    showToast('Could not update saved items.');
  } finally {
    btn.disabled = false;
  }
}

async function removeFav(pid, el, options = {}) {
  if(_sb && _user) await _sb.from('favorites').delete().eq('user_id',_user.id).eq('product_id',pid);
  _favs = _favs.filter(f => f.product_id !== pid);
  _homeFavoriteCache.delete(pid);
  if(el) el.remove();
  refreshHearts();
  void refreshCartFavs();
  if (!options?.silentToast) showToast('Removed from favorites.');
}

/* CART */
let cartItems = [];

function renderCart() {
  // The cart drawer was removed from this page (the bag button navigates to
  // /bag.html). This keeps cartItems fresh and the nav badge count in sync —
  // which is all the homepage needs.
  const cart = normalizeCartPricing(JSON.parse(localStorage.getItem('cart')) || []);
  cartItems = cart;
  const ccEl = document.querySelector('.cc');
  if (ccEl) {
    const newCount = cart.reduce((sum, item) => sum + item.quantity, 0);
    const oldCount = parseInt(ccEl.textContent) || 0;
    ccEl.textContent = newCount;
    if (newCount > oldCount) {
      ccEl.classList.remove('pop');
      void ccEl.offsetWidth; // force reflow to restart animation
      ccEl.classList.add('pop');
      ccEl.addEventListener('animationend', () => ccEl.classList.remove('pop'), { once: true });
    }
  }
}

function clearStorefrontOverlayState() {
  document.querySelectorAll('.modal.open').forEach(modal => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  });
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
  if (window.ZWModalScrollLock && typeof window.ZWModalScrollLock.refresh === 'function') {
    window.ZWModalScrollLock.refresh();
  }
}

// Cart is now a dedicated page.
window.__zwOpenCart = function() {
  clearStorefrontOverlayState();
  location.assign('/bag.html');
  return false;
};
window.__zwCloseCart = function() { history.back(); return false; };

document.getElementById('cart-btn').addEventListener('click', (e) => { e.preventDefault(); window.__zwOpenCart(); });
window.addEventListener('DOMContentLoaded', renderCart);

// â”€â”€â”€ Quick Add to Bag â€” two-step: Colorway â†’ Size â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function closeQuickSizePanel(panelId) {
  const panel = document.getElementById(panelId);
  if (panel) panel.classList.remove('open');
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.pcard')) {
    document.querySelectorAll('.quick-size-panel.open').forEach(p => p.classList.remove('open'));
  }
});

function shouldBypassQuickAddModal() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function quickAddGoToProduct(payload) {
  const href = productHref({
    id: payload.productId,
    sku: payload.sku,
    title: payload.title
  });
  window.location.assign(href);
}

/* The quick-add modal subsystem (quickAddToCart, openQuickAddReviewModal,
   gallery/options renderers, init) lives in quick-add-modal.js — the single
   shared module loaded by index.html (before this file) and bag.html. Grid-side
   wiring below calls window.quickAddToCart from that module. */

window.__zwQuickAddClick = function(e, btn) {
  if (!btn || !btn.matches || !btn.matches('.pcard-add-btn[data-quick-add]')) return true;
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

  let payload = {};
  try {
    payload = JSON.parse(decodeURIComponent(btn.dataset.quickAdd || '{}'));
  } catch (err) {
    console.error('Quick add payload parse failed:', err);
    showToast('Unable to open product options');
    return;
  }

  if (shouldBypassQuickAddModal()) {
    quickAddGoToProduct(payload);
    return false;
  }

  window.quickAddToCart(
    payload.productId,
    payload.title,
    payload.price,
    payload.sku,
    payload.image,
    payload.weightLb,
    btn
  );
  return false;
};

document.addEventListener('click', function(e) {
  const btn = e.target.closest('.pcard-add-btn[data-quick-add]');
  if (!btn) return;
  window.__zwQuickAddClick(e, btn);
}, true);

/* ── Nike-style card color swatches (swatch mode) ───────────────────────────
   Hover a swatch → swap the card photo to that color's image and KEEP it there
   (the card sticks on the last colour you hovered; a page refresh re-renders the
   default). Click a swatch → open the add-to-bag modal preselected to that
   color (on mobile the modal bypasses to the product page, same as Add to Bag). */
function _zwSetActivePcardSwatch(sw) {
  const row = sw.closest('.zw-card-swatches');
  if (row) row.querySelectorAll('.zw-card-swatch').forEach((s) => s.classList.toggle('active', s === sw));
}
document.addEventListener('mouseover', function (e) {
  const sw = e.target.closest('.zw-card-swatch'); if (!sw || sw.classList.contains('zw-swatch-more')) return;
  const card = sw.closest('.pcard'); const img = card && card.querySelector('.pcard-img img');
  if (!img || !sw.dataset.img) return;
  img.setAttribute('src', sw.dataset.img);
  _zwSetActivePcardSwatch(sw);
});
document.addEventListener('click', function (e) {
  const sw = e.target.closest('.zw-card-swatch'); if (!sw) return;
  e.preventDefault(); e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  // Mobile: a thumbnail tap just previews that colorway on the card — no modal.
  if (window.matchMedia && window.matchMedia('(max-width:760px)').matches) {
    if (!sw.classList.contains('zw-swatch-more')) {
      const mcard = sw.closest('.pcard'); const mimg = mcard && mcard.querySelector('.pcard-img img');
      if (mimg && sw.dataset.img) mimg.setAttribute('src', sw.dataset.img);
      _zwSetActivePcardSwatch(sw);
    }
    return;
  }
  const row = sw.closest('.zw-card-swatches'); if (!row) return;
  let payload = {};
  try { payload = JSON.parse(decodeURIComponent(row.dataset.quickAdd || '{}')); }
  catch (_) { showToast('Unable to open product options'); return; }
  if (shouldBypassQuickAddModal()) { quickAddGoToProduct(payload); return; }
  window.quickAddToCart(payload.productId, payload.title, payload.price, payload.sku, payload.image, payload.weightLb, null, sw.dataset.colorName || null);
}, true);

/* (quick-add modal internals removed — see quick-add-modal.js) */

/* Swipe-down-to-close for the bottom-sheet modals (mirrors product.html).
   If the user drags down >80px while the sheet is scrolled to the very top,
   dismiss it by clicking the existing close button so all teardown runs. */
function zwAttachSwipeClose(scrollEl, closeBtn) {
  if (!scrollEl || !closeBtn) return;
  let startY = 0, tracking = false;
  scrollEl.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { tracking = false; return; }
    startY = e.touches[0].clientY;
    tracking = scrollEl.scrollTop <= 0;
  }, { passive: true });
  scrollEl.addEventListener('touchmove', () => {
    if (tracking && scrollEl.scrollTop > 0) tracking = false;
  }, { passive: true });
  scrollEl.addEventListener('touchend', e => {
    if (!tracking) return; tracking = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 80 && scrollEl.scrollTop <= 0) closeBtn.click();
  }, { passive: true });
}
[
  ['all-reviews-modal', '.review-list-mbox', 'all-reviews-close'],
  ['review-modal', '.review-mbox', 'review-modal-close'],
  ['auth-modal', '.mbox', 'auth-modal-close'],
  ['account-modal', '.mbox', 'account-modal-close'],
  ['quick-add-review-modal', '.mbox', 'quick-add-review-close'],
].forEach(([modalId, scrollSel, closeId]) => {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  zwAttachSwipeClose(modal.querySelector(scrollSel) || modal.firstElementChild, document.getElementById(closeId));
});

/* STRIPE ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â lazy-loaded on first checkout click */
let stripe = null, elements = null, card = null;
let _stripeReady = false, _stripeLoading = false;
const _stripeQueue = [];
let _stripeInitPromise = null;
function _loadStripe(cb) {
  if (_stripeReady) { cb(); return; }
  _stripeQueue.push(cb);
  if (_stripeLoading) return;
  _stripeLoading = true;
  const s = document.createElement('script');
  s.src = 'https://js.stripe.com/v3/';
  s.onload = () => { _stripeReady = true; _stripeQueue.splice(0).forEach(f => f()); };
  document.head.appendChild(s);
}
function getCheckoutCardStyle() {
  const isLight = document.body.classList.contains('light-mode');
  return {
    base: {
      color: isLight ? '#09090b' : '#f4f1eb',
      iconColor: isLight ? '#09090b' : '#f4f1eb',
      fontFamily:'"Barlow",sans-serif',
      fontSmoothing:'antialiased',
      fontSize:'16px',
      fontWeight:'500',
      letterSpacing:'0',
      '::placeholder':{ color: isLight ? 'rgba(9,9,11,.58)' : 'rgba(244,241,235,.38)' }
    },
    invalid: { color:'#c0392b', iconColor:'#c0392b' }
  };
}
function refreshCheckoutCardTheme() {
  if (card?.update) card.update({ style: getCheckoutCardStyle() });
}
async function _initStripe() {
  if (stripe) return stripe;
  if (_stripeInitPromise) return _stripeInitPromise;
  _stripeInitPromise = (async () => {
    const publishableKey = await window.zwGetStripePublishableKey();
    stripe = Stripe(publishableKey);
    elements = stripe.elements();
    card = elements.create('card', {
      style: getCheckoutCardStyle()
    });
    card.mount('#stripe-card-element');
    return stripe;
  })().catch((error) => {
    _stripeInitPromise = null;
    throw error;
  });
  return _stripeInitPromise;
}
window.addEventListener('zw-theme-applied', refreshCheckoutCardTheme);

async function post(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  return r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}
async function getCheckoutUserId() {
  if (_user?.id) return _user.id;
  if (!_sb?.auth?.getUser) return null;
  try {
    const { data } = await _sb.auth.getUser();
    return data?.user?.id || null;
  } catch {
    return null;
  }
}
async function getCheckoutAccessToken() {
  if (!_sb?.auth?.getSession) return null;
  try {
    const { data } = await _sb.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}
function getCheckoutTaxStateCode(fallback = '') {
  const fieldState = document.getElementById('pay-state')?.value || '';
  return window.ZWCheckoutTax?.normalizeStateCode(fieldState || fallback || _detectedStateCode) || '';
}
function getCheckoutTaxCents(subtotalCents, stateCode = '') {
  return window.ZWCheckoutTax?.taxCents(subtotalCents, getCheckoutTaxStateCode(stateCode)) || 0;
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); setPageScrollLock(false); }
let _paymentReturnModalId = null;

function getWalletTaxCents(subtotalCents, stateCode = '') {
  return getCheckoutTaxCents(subtotalCents, stateCode);
}

function getDefaultCheckoutShippingCents(subtotalCents) {
  if (subtotalCents <= 0) return 0;
  const policy = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
  const qualifiesFree = policy.enabled && (subtotalCents / 100) >= policy.threshold;
  return qualifiesFree ? 0 : Math.round((policy.standardRate || 8) * 100);
}

function getWalletTotalCents(subtotalCents, shippingCents = 0, stateCode = '') {
  return subtotalCents + shippingCents + getWalletTaxCents(subtotalCents, stateCode);
}

function getWalletDisplayItems(subtotalCents, shippingCents, stateCode = '') {
  return [
    { label: 'Subtotal', amount: Math.max(0, subtotalCents || 0) },
    { label: 'Shipping', amount: Math.max(0, shippingCents || 0) },
    { label: 'Tax', amount: getWalletTaxCents(subtotalCents, stateCode) }
  ];
}

var _detectedStateCode = '';
let _detectStatePromise = null;

async function prefillCheckoutStateFromGeo() {
  const stateInput = document.getElementById('pay-state');
  if (!stateInput) return;

  if (stateInput.value.trim().length >= 2) return;

  const applyDetectedState = (value) => {
    if (!value || stateInput.value.trim()) return;
    stateInput.value = value;
    stateInput.dispatchEvent(new Event('input', { bubbles: true }));
  };

  if (_detectedStateCode) {
    applyDetectedState(_detectedStateCode);
    return;
  }

  if (!_detectStatePromise) {
    _detectStatePromise = (async () => {
      try {
        const resp = await fetch('/api/detect-state', { method: 'GET', cache: 'no-store' });
        if (!resp.ok) return '';
        const data = await resp.json();
        const candidate = String(data?.state || '').toUpperCase().trim();
        if (data?.country === 'US' && /^[A-Z]{2}$/.test(candidate)) return candidate;
        return '';
      } catch (_) {
        return '';
      }
    })();
  }

  const detected = await _detectStatePromise;
  _detectStatePromise = null;
  if (detected) _detectedStateCode = detected;
  applyDetectedState(detected);
}

function openPaymentModal(subtotalCents) {
  const cartModal = document.getElementById('cart-modal');
  _paymentReturnModalId = cartModal?.classList.contains('open') ? 'cart-modal' : null;
  if (_paymentReturnModalId) cartModal.classList.remove('open');
  const coPage = document.getElementById('checkout-page');
  if (!coPage) return;
  coPage.classList.add('open');
  const itemsLine = document.getElementById('co-items-line');
  if (itemsLine) {
    const n = cartItems.length;
    const total = subtotalCents / 100;
    itemsLine.textContent = `${n} item${n !== 1 ? 's' : ''} Â· $${total.toFixed(2)}`;
  }
  setPageScrollLock(true);
  document.getElementById('pay-error').textContent = '';

  // Pre-fill name + email from logged-in session so the user doesn't have to retype them
  const emailInput = document.getElementById('pay-email');
  const nameInput  = document.getElementById('pay-name');
  if (_user) {
    const userEmail = _user.email || '';
    const userName  = _user.user_metadata?.full_name || '';
    if (userEmail && !emailInput.value) {
      emailInput.value = userEmail;
      emailInput.readOnly = true;
      emailInput.style.opacity = '0.6';
      emailInput.style.cursor  = 'default';
    }
    if (userName && !nameInput.value) {
      nameInput.value = userName;
    }
  } else {
    // Reset in case user logged out mid-session
    emailInput.readOnly = false;
    emailInput.style.opacity = '';
    emailInput.style.cursor  = '';
  }

  void prefillCheckoutStateFromGeo();
  _loadStripe(() => {
    void _initStripe()
      .then(() => {
        refreshCheckoutCardTheme();
        return initPR(subtotalCents);
      })
      .catch((error) => {
        document.getElementById('pay-error').textContent = error?.message || 'Unable to load secure checkout.';
      });
  });
}

function closePaymentModal({ suppressReturn = false } = {}) {
  document.getElementById('checkout-page')?.classList.remove('open');
  const shouldReturnToCart = !suppressReturn && _paymentReturnModalId === 'cart-modal';
  _paymentReturnModalId = null;
  if (shouldReturnToCart) {
    renderCart();
    document.getElementById('cart-modal')?.classList.add('open');
    setPageScrollLock(true);
    return;
  }
  setPageScrollLock(false);
}

let payReq = null, payReqButton = null, selRate = null, walletRates = [], walletShippingCents = 0, walletTaxStateCode = '';
function resetWalletUi() {
  const walletHost = document.getElementById('payment-request-btn');
  const walletHints = document.getElementById('wallet-methods');
  const divider = document.getElementById('pay-divider');
  if (payReqButton) {
    try { payReqButton.unmount(); } catch {}
    payReqButton = null;
  }
  if (walletHost) {
    walletHost.innerHTML = '';
    walletHost.style.display = 'none';
  }
  if (walletHints) {
    walletHints.innerHTML = '';
    walletHints.style.display = 'none';
  }
  walletShippingCents = 0;
  walletTaxStateCode = '';
  if (divider) divider.style.display = 'none';
}
function isApplePayDevice() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod|Macintosh|Mac OS X|MacIntel/i.test(`${ua} ${platform}`) || touchMac;
}

function renderWalletHints(result) {
  const walletHints = document.getElementById('wallet-methods');
  if (!walletHints) return;
  const appleAvail  = isApplePayDevice() && !!result?.applePay;
  const googleAvail = !!result?.googlePay;
  const appleIcon  = `<span class="wallet-chip__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg></span>`;
  const googleIcon = `<span class="wallet-chip__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg></span>`;

  let html = '';
  if (appleAvail) {
    html += `<button type="button" class="wallet-chip wallet-chip--applePay" data-wallet="applePay" data-action="pay">${appleIcon}<span class="wallet-chip__label"><span class="wallet-chip__brand">Apple</span><span>Pay</span></span></button>`;
  }
  // Google Pay Ã¢â‚¬â€ only show when actually available
  if (googleAvail) {
    html += `<button type="button" class="wallet-chip wallet-chip--googlePay" data-wallet="googlePay" data-action="pay">${googleIcon}<span class="wallet-chip__label"><span class="wallet-chip__brand">Google</span><span>Pay</span></span></button>`;
  }

  if (!html) {
    walletHints.innerHTML = '';
    walletHints.style.display = 'none';
    return;
  }

  walletHints.innerHTML = html;

  walletHints.querySelectorAll('button[data-action="pay"]').forEach(btn => {
    btn.addEventListener('click', () => { if (payReq?.show) payReq.show(); });
  });
  walletHints.style.display = 'flex';
  walletHints.style.flexDirection = 'column';
  walletHints.style.gap = '.55rem';
}
function initPR(subtotalCents) {
  const normalizedSubtotalCents = Math.max(0, subtotalCents || 0);
  const defaultShippingCents = getDefaultCheckoutShippingCents(normalizedSubtotalCents);
  resetWalletUi();
  walletRates = [];
  selRate = null;
  walletShippingCents = defaultShippingCents;
  walletTaxStateCode = getCheckoutTaxStateCode();
  payReq = stripe.paymentRequest({
    country:'US',
    currency:'usd',
    total:{ label:'Zuwera', amount:getWalletTotalCents(normalizedSubtotalCents, defaultShippingCents, walletTaxStateCode), pending:true },
    displayItems:getWalletDisplayItems(normalizedSubtotalCents, defaultShippingCents, walletTaxStateCode),
    requestPayerName:true,
    requestPayerEmail:true,
    requestShipping:true,
    shippingOptions:[],
  });
  payReq.on('shippingaddresschange', async ev => {
    const a = ev.shippingAddress;
    walletTaxStateCode = getCheckoutTaxStateCode(a.region);
    const policy = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
    const qualifiesFree = policy.enabled && (normalizedSubtotalCents / 100) >= policy.threshold;

    // Helper: fall back to flat/free rate so checkout never hard-fails
    function useFlatRate() {
      walletRates = [];
      selRate = null;
      walletShippingCents = defaultShippingCents; // 0 when free, standard rate otherwise
      ev.updateWith({
        status:'success',
        shippingOptions:[{
          id:'flat_rate',
          label: qualifiesFree ? 'Free Shipping' : 'Standard Shipping',
          detail: qualifiesFree ? '' : 'Est. 5-7 business days',
          amount: defaultShippingCents
        }],
        total:{ label:'Zuwera', amount:getWalletTotalCents(normalizedSubtotalCents, defaultShippingCents, walletTaxStateCode) },
        displayItems:getWalletDisplayItems(normalizedSubtotalCents, defaultShippingCents, walletTaxStateCode)
      });
    }
    try {
      // Apple Pay / Google Pay withhold street during shippingaddresschange for privacy.
      // Use placeholder so Shippo can calculate rates by zip/state.
      const line1 = a.addressLine?.[0] || '1 Main St';
      const _walletTotalItems  = cartItems.reduce((s, i) => s + (i.quantity || 1), 0) || 1;
      const _walletTotalWeight = cartItems.reduce((s, i) => s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1)), 0) || 0.5;
      const d = await post('/api/shippo-rates', { address:{ name:'', line1, city:a.city, state:a.region, zip:a.postalCode, country:a.country }, items: cartItems, totalItems: _walletTotalItems, totalWeightLb: _walletTotalWeight });
      if(!d.rates?.length){ useFlatRate(); return; }

      if (qualifiesFree) {
        // Order qualifies for free shipping Ã¢â‚¬â€ store cheapest rate for metadata, show Free to customer
        walletRates = d.rates.slice(0,4);
        selRate = walletRates[0] || null;
        walletShippingCents = 0;
        ev.updateWith({
          status:'success',
          shippingOptions:[{ id:'free', label:'Free Shipping', detail:'', amount:0 }],
          total:{ label:'Zuwera', amount:getWalletTotalCents(normalizedSubtotalCents, 0, walletTaxStateCode) },
          displayItems:getWalletDisplayItems(normalizedSubtotalCents, 0, walletTaxStateCode)
        });
      } else {
        walletRates = d.rates.slice(0,4);
        const opts = walletRates.map(r => ({ id:r.objectId, label:`${r.provider} ${r.servicelevel}`, detail:r.days?`Est. ${r.days} business days`:'', amount:Math.round(parseFloat(r.amount)*100) }));
        selRate = walletRates[0] || null;
        walletShippingCents = opts[0]?.amount ?? defaultShippingCents;
        ev.updateWith({
          status:'success',
          shippingOptions:opts,
          total:{ label:'Zuwera', amount:getWalletTotalCents(normalizedSubtotalCents, walletShippingCents, walletTaxStateCode) },
          displayItems:getWalletDisplayItems(normalizedSubtotalCents, walletShippingCents, walletTaxStateCode)
        });
      }
    } catch { useFlatRate(); }
  });
  payReq.on('shippingoptionchange', ev => {
    const matchedRate = walletRates.find(r => r.objectId === ev.shippingOption?.id);
    if (matchedRate) selRate = matchedRate;
    const shippingAmount = matchedRate
      ? Math.round(parseFloat(matchedRate.amount) * 100)
      : (ev.shippingOption?.amount || defaultShippingCents);
    walletShippingCents = shippingAmount;
    ev.updateWith({
      status:'success',
      total:{ label:'Zuwera', amount:getWalletTotalCents(normalizedSubtotalCents, shippingAmount, walletTaxStateCode) },
      displayItems:getWalletDisplayItems(normalizedSubtotalCents, shippingAmount, walletTaxStateCode)
    });
  });
  payReq.on('paymentmethod', async ev => {
    try {
      const a = ev.shippingAddress||{};
      const userId = await getCheckoutUserId();
      const accessToken = await getCheckoutAccessToken();
      const policy = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
      const qualifiesFree = policy.enabled && (normalizedSubtotalCents / 100) >= policy.threshold;
      // Use nullish coalescing so $0 shipping (free) is preserved and not replaced by the fallback
      const effectiveShippingCents = walletShippingCents ?? defaultShippingCents;
      const d = await post('/api/create-payment-intent', {
        items:cartItems,
        shippingRate:selRate,
        shippingAmountCents: effectiveShippingCents,
        freeShipping: qualifiesFree,
        userId,
        accessToken,
        address:{ name:ev.payerName||'', email:ev.payerEmail||'', line1:a.addressLine?.[0]||'', line2:a.addressLine?.[1]||'', city:a.city||'', state:a.region||'', zip:a.postalCode||'', country:a.country||'US' }
      });
      if(d.error){
        ev.complete('fail');
        document.getElementById('pay-error').textContent = d.error;
        return;
      }
      const initialResult = await stripe.confirmCardPayment(
        d.clientSecret,
        { payment_method: ev.paymentMethod.id },
        { handleActions: false }
      );
      if (initialResult.error) {
        ev.complete('fail');
        document.getElementById('pay-error').textContent = initialResult.error.message;
        return;
      }

      let finalIntent = initialResult.paymentIntent;
      if (finalIntent?.status === 'requires_action') {
        const actionResult = await stripe.confirmCardPayment(d.clientSecret);
        if (actionResult.error) {
          ev.complete('fail');
          document.getElementById('pay-error').textContent = actionResult.error.message;
          return;
        }
        finalIntent = actionResult.paymentIntent;
      }

      const successStatuses = ['succeeded', 'processing', 'requires_capture'];
      if (!finalIntent || !successStatuses.includes(finalIntent.status)) {
        ev.complete('fail');
        document.getElementById('pay-error').textContent = `Payment is ${finalIntent?.status || 'incomplete'}. Please try again.`;
        return;
      }

      ev.complete('success');
      closePaymentModal({ suppressReturn:true });
      showConfirmed(finalIntent.id || d.orderId, ev.payerEmail);
    } catch(e){
      ev.complete('fail');
      document.getElementById('pay-error').textContent = 'Fast checkout could not be completed. Please try card checkout.';
    }
  });
  payReq.canMakePayment().then(result => {
    const divider = document.getElementById('pay-divider');
    const hasWallet = !!((isApplePayDevice() && result?.applePay) || result?.googlePay);
    if (divider) divider.style.display = hasWallet ? 'block' : 'none';
    renderWalletHints(hasWallet ? result : {});
  }).catch(() => {
    const divider = document.getElementById('pay-divider');
    if (divider) divider.style.display = 'none';
    renderWalletHints({});
  });
}

let rateTimer = null;
function _getCurrentSubtotal() {
  return parseFloat((document.getElementById('summary-subtotal')?.textContent||'0').replace(/[^0-9.]/g,'')) || 0;
}
function maybeLoadRates() {
  const zip = document.getElementById('pay-zip').value.trim();
  const state = document.getElementById('pay-state').value.trim();
  if(zip.length < 5 || state.length < 2) return;
  clearTimeout(rateTimer);
  rateTimer = setTimeout(async () => {
    const policy        = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
    const subtotal      = _getCurrentSubtotal();
    const qualifiesFree = policy.enabled && subtotal >= policy.threshold;

    document.getElementById('shipping-rates-field').style.display = 'none';
    document.getElementById('shipping-free-row').style.display    = 'none';

    if (qualifiesFree) {
      // Silently fetch cheapest rate for fulfillment metadata Ã¢â‚¬â€ customer pays nothing
      document.getElementById('shipping-free-row').style.display = 'flex';
      try {
        const _freeTotalItems  = cartItems.reduce((s, i) => s + (i.quantity || 1), 0) || 1;
        const _freeTotalWeight = cartItems.reduce((s, i) => s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1)), 0) || 0.5;
        const d = await post('/api/shippo-rates', { address:{ name:document.getElementById('pay-name').value.trim(), line1:document.getElementById('pay-addr1').value.trim(), city:document.getElementById('pay-city').value.trim(), state, zip, country:'US' }, items: cartItems, totalItems: _freeTotalItems, totalWeightLb: _freeTotalWeight });
        if(d.rates?.length) selRate = d.rates[0]; // cheapest â€” customer pays $0
      } catch(e){ /* silent */ }
      return;
    }

    // Not qualifying for free â€” show live Shippo rates for customer to choose
    document.getElementById('shipping-rates-loading').style.display = 'block';
    try {
      const _paidTotalItems  = cartItems.reduce((s, i) => s + (i.quantity || 1), 0) || 1;
      const _paidTotalWeight = cartItems.reduce((s, i) => s + ((parseFloat(i.weightLb) || 0.5) * (i.quantity || 1)), 0) || 0.5;
      const d = await post('/api/shippo-rates', { address:{ name:document.getElementById('pay-name').value.trim(), line1:document.getElementById('pay-addr1').value.trim(), city:document.getElementById('pay-city').value.trim(), state, zip, country:'US' }, items: cartItems, totalItems: _paidTotalItems, totalWeightLb: _paidTotalWeight });
      document.getElementById('shipping-rates-loading').style.display = 'none';
      if(!d.rates?.length) return;
      const list = document.getElementById('shipping-rates-list'); list.innerHTML='';
      d.rates.slice(0,5).forEach((rate, i) => {
        const el = document.createElement('div');
        el.className = 'rate-opt' + (i===0?' selected':'');
        el.innerHTML = `<span class="rate-name">${escapeHomeFavoriteHtml(rate.provider)} ${escapeHomeFavoriteHtml(rate.servicelevel)}</span><span class="rate-meta">${rate.days ? escapeHomeFavoriteHtml(String(rate.days)) + ' business days' : ''}</span><span class="rate-price">$${parseFloat(rate.amount).toFixed(2)}</span>`;
        el.addEventListener('click', () => { document.querySelectorAll('.rate-opt').forEach(x => x.classList.remove('selected')); el.classList.add('selected'); selRate=rate; updateShip(rate.amount); });
        list.appendChild(el);
      });
      selRate = d.rates[0]; updateShip(d.rates[0].amount);
      document.getElementById('shipping-rates-field').style.display = 'block';
    } catch(e) {
      document.getElementById('shipping-rates-loading').style.display = 'none';
      const ratesList = document.getElementById('shipping-rates-list');
      if (ratesList) ratesList.innerHTML = '<div style="padding:.8rem;text-align:center;color:rgba(244,241,235,.4);font-size:.8rem;">Could not load shipping options. Please check your address and try again.</div>';
    }
  }, 600);
}
function updateShip(amount) {
  const p = el => parseFloat((document.getElementById(el)?.textContent||'0').replace(/[^0-9.]/g,''));
  const se = document.getElementById('summary-shipping');
  const te = document.getElementById('summary-total');
  if(se) se.textContent = '$'+parseFloat(amount).toFixed(2);
  if(te) te.textContent = '$'+(p('summary-subtotal')+parseFloat(amount)+p('summary-tax')).toFixed(2);
}
function updateTaxEstimateForState() {
  const subtotal = _getCurrentSubtotal();
  if (!subtotal) return;
  const tax = window.ZWCheckoutTax?.taxDollars(subtotal, getCheckoutTaxStateCode()) || 0;
  const taxEl = document.getElementById('summary-tax');
  const totalEl = document.getElementById('summary-total');
  const shippingText = document.getElementById('summary-shipping')?.textContent || '';
  const shipping = /^free$/i.test(shippingText.trim()) ? 0 : (parseFloat(shippingText.replace(/[^0-9.]/g, '')) || 0);
  if (taxEl) taxEl.textContent = '$' + tax.toFixed(2);
  if (totalEl) totalEl.textContent = '$' + (subtotal + shipping + tax).toFixed(2);
}
document.getElementById('pay-zip').addEventListener('input', maybeLoadRates);
document.getElementById('pay-state').addEventListener('input', () => { updateTaxEstimateForState(); maybeLoadRates(); });
document.getElementById('co-back')?.addEventListener('click', () => { closePaymentModal(); document.getElementById('pay-error').textContent=''; });

document.getElementById('pay-submit').addEventListener('click', async () => {
  const g = id => document.getElementById(id).value.trim();
  const name=g('pay-name'),email=g('pay-email'),addr1=g('pay-addr1'),addr2=g('pay-addr2'),city=g('pay-city'),state=g('pay-state'),zip=g('pay-zip');
  const err=document.getElementById('pay-error'),btxt=document.getElementById('pay-btn-text'),btn=document.getElementById('pay-submit');
  err.textContent='';
  if(!name||!email){ err.textContent='Please enter your name and email.'; return; }
  if(!addr1||!city||!state||!zip){ err.textContent='Please enter your full shipping address.'; return; }
  const _policy        = window._shippingPolicy || { enabled: true, threshold: 100, standardRate: 8 };
  const _sub           = _getCurrentSubtotal();
  const _qualifiesFree = _policy.enabled && _sub >= _policy.threshold;
  if(!_qualifiesFree && !selRate){ err.textContent='Please enter your ZIP and state to load shipping options.'; return; }
  btn.disabled=true; btxt.textContent='Processing...';
  try {
    await _initStripe();
    const userId = await getCheckoutUserId();
    const accessToken = await getCheckoutAccessToken();
    const d = await post('/api/create-payment-intent', { items:cartItems, shippingRate:selRate, freeShipping:_qualifiesFree, userId, accessToken, address:{name,email,line1:addr1,line2:addr2,city,state,zip,country:'US'} });
    if(d.error){ err.textContent=d.error; btn.disabled=false; btxt.textContent='Pay Now'; return; }
    const { error, paymentIntent } = await stripe.confirmCardPayment(d.clientSecret, { payment_method:{ card, billing_details:{name,email} }, receipt_email:email });
    if(error){ err.textContent=error.message; btn.disabled=false; btxt.textContent='Pay Now'; return; }
    closePaymentModal({ suppressReturn:true }); showConfirmed(paymentIntent.id, email);
  } catch(e){ err.textContent='Something went wrong. Please try again.'; btn.disabled=false; btxt.textContent='Pay Now'; }
});

function showConfirmed(piId, email) {
  const oid = (piId||'').slice(-8).toUpperCase();
  document.getElementById('success-order').textContent = oid ? 'Order #' + oid : '';
  document.getElementById('success-msg').textContent = `Thank you! A confirmation has been sent to ${email||'your email'}.`;
  document.getElementById('payment-success').classList.add('open');
  setPageScrollLock(true);
  cartItems=[];
  localStorage.removeItem('cart');
  const _cil = document.getElementById('cart-items-list'); if (_cil) _cil.innerHTML='';
  document.getElementById('cart-empty-msg').style.display='block';
  document.querySelector('.cc').textContent='0';
}
document.getElementById('success-continue').addEventListener('click', () => { document.getElementById('payment-success').classList.remove('open'); setPageScrollLock(false); });

/* COUNTDOWN */
const dropDate = new Date('2026-09-20T00:00:00');
const els = {
  d: document.getElementById('hcd-days'),
  h: document.getElementById('hcd-hours'),
  m: document.getElementById('hcd-mins'),
  s: document.getElementById('hcd-secs'),
};
// Only update + animate when the displayed value actually changes,
// so the flip fires on the seconds every second, and on minutes/hours/days
// only when they roll over - not on every tick.
function setUnit(el, n) {
  if (!el) return;
  const val = String(Math.floor(n)).padStart(2, '0');
  if (el.textContent === val) return;
  el.textContent = val;
  el.classList.remove('flip');
  void el.offsetWidth; // force reflow so animation restarts
  el.classList.add('flip');
}
function tick() {
  const targetDate = window.__zwDropDate || dropDate;
  const diff = targetDate - new Date();
  if (diff <= 0) {
    setUnit(els.d, 0);
    setUnit(els.h, 0);
    setUnit(els.m, 0);
    setUnit(els.s, 0);
    return;
  }
  setUnit(els.d, diff / 864e5);
  setUnit(els.h, (diff % 864e5) / 36e5);
  setUnit(els.m, (diff % 36e5) / 6e4);
  setUnit(els.s, (diff % 6e4) / 1e3);
}
tick(); const cdI = setInterval(tick, 1000);

/* NOTIFY */
async function homeNotifyMe() {
  const btn = document.querySelector('.notify-row button');
  if(btn && btn.disabled) return;
  if(btn) btn.disabled = true;
  const inp = document.getElementById('home-notify-email');
  const email = inp.value.trim();
  if(!email||!email.includes('@')){ inp.style.outlineColor='var(--red)'; inp.focus(); if(btn) btn.disabled=false; return; }
  inp.style.outlineColor='';

  if(_sb){ try{ await _sb.from('waitlist').upsert({ email, source:'drop001_home' }); } catch{} }
  if (typeof gtag === 'function') gtag('event', 'generate_lead', { content_name: 'waitlist', source: 'home' });
  if (window.zwPixel) zwPixel.lead('waitlist');
  inp.closest('.notify-row').style.display='none';
  document.querySelector('.notify-hint').style.display='none';
  document.getElementById('home-notify-success').style.display='block';
}

/* FOOTER NEWSLETTER */
async function zwHomeNewsletterSubmit() {
  const input = document.getElementById('nl-email');
  const email = (input ? input.value : '').trim();
  if (!email || !email.includes('@')) { if (input) { input.style.borderColor = '#e07060'; input.focus(); } return; }
  if (input) input.style.borderColor = '';
  const form = document.getElementById('nl-form');
  const success = document.getElementById('nl-success');
  if (form) form.style.display = 'none';
  if (success) success.style.display = 'block';
  if (typeof gtag === 'function') gtag('event', 'generate_lead', { content_name: 'newsletter', source: 'home_footer' });
  if (window.zwPixel) zwPixel.lead('newsletter');
  if (_sb) { try { await _sb.from('waitlist').upsert({ email, source: 'newsletter_footer_home' }); } catch(_) {} }
}

/* SCROLL TO NOTIFY */
function scrollToNotify() {
  const el = document.getElementById('home-notify-email');
  el.scrollIntoView({ behavior:'smooth', block:'center' });
  setTimeout(() => el.focus(), 600);
}


(function(){
  if(!localStorage.getItem('zw_cookie_consent')){
    document.getElementById('cookie-banner').style.display='flex';
  }
})();
function acceptCookies(){try{localStorage.setItem('zw_cookie_consent','accepted');}catch(e){}document.getElementById('cookie-banner').style.display='none'}
function declineCookies(){try{localStorage.setItem('zw_cookie_consent','declined');}catch(e){}document.getElementById('cookie-banner').style.display='none'}

/* â”€â”€ Modal backdrop transparency enforcer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Applies transparent background via inline setProperty (beats all stylesheets,
   including cross-origin ones that ignore CSS !important overrides).
   Watches for class/style mutations so it fires whenever any modal opens.     */
(function() {
  function clearBackdrop(el) {
    if (!el || !el.classList || !el.classList.contains('modal')) return;
    el.style.setProperty('background', 'transparent', 'important');
    el.style.setProperty('backdrop-filter', 'none', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
  }

  var attrObs = new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) { clearBackdrop(muts[i].target); }
  });

  function observe(el) {
    clearBackdrop(el);
    attrObs.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  function init() {
    document.querySelectorAll('.modal').forEach(observe);
    // Watch for dynamically-inserted modals (e.g. #zw-lang-modal from lang.js)
    new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        muts[i].addedNodes.forEach(function(n) {
          if (n.nodeType === 1) {
            if (n.classList && n.classList.contains('modal')) observe(n);
            n.querySelectorAll && n.querySelectorAll('.modal').forEach(observe);
          }
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

(function() {
  function closeReturnsModal() {
    var modal = document.getElementById('returns-modal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  function initReturnsModalClose() {
    var modal = document.getElementById('returns-modal');
    var closeBtn = document.getElementById('returns-close');
    if (closeBtn) closeBtn.addEventListener('click', closeReturnsModal);
    if (modal) {
      modal.addEventListener('click', function(event) {
        if (event.target === modal) closeReturnsModal();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      _sb = window.sb; // supabase-client.js (deferred) has now run
      _initAuth();
      initReturnsModalClose();
    });
  } else {
    _sb = window.sb;
    _initAuth();
    initReturnsModalClose();
  }
})();

window.openWatchModal = function(url) {
   let modal = document.getElementById('zw-watch-modal');
   if(!modal) {
      modal = document.createElement('div');
      modal.id = 'zw-watch-modal';
      modal.innerHTML = `
        <div class="zw-wm-backdrop" onclick="closeWatchModal()"></div>
        <div class="zw-wm-content">
           <button class="zw-wm-close" onclick="closeWatchModal()">✕</button>
           <div class="zw-wm-vid-container" id="zw-wm-container"></div>
        </div>
      `;
      document.body.appendChild(modal);
      const style = document.createElement('style');
      style.textContent = `
        #zw-watch-modal { position:fixed; inset:0; z-index:99999; display:none; align-items:center; justify-content:center; }
        #zw-watch-modal.open { display:flex; }
        .zw-wm-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.85); backdrop-filter:blur(5px); }
        .zw-wm-content { position:relative; z-index:1; width:90%; max-width:1100px; aspect-ratio:16/9; background:#000; border-radius:8px; overflow:hidden; box-shadow:0 25px 50px -12px rgba(0,0,0,0.5); }
        .zw-wm-close { position:absolute; top:-40px; right:0; color:#fff; background:none; border:none; font-size:1.5rem; cursor:pointer; padding:10px; }
        .zw-wm-vid-container { width:100%; height:100%; }
        .zw-wm-vid-container iframe, .zw-wm-vid-container video { width:100%; height:100%; border:none; outline:none; }
      `;
      document.head.appendChild(style);
   }
   
   const container = document.getElementById('zw-wm-container');
   const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
   const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
   if(ytMatch) {
      container.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytMatch[1]}?autoplay=1&rel=0" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
   } else if (vimeoMatch) {
      container.innerHTML = `<iframe src="https://player.vimeo.com/video/${vimeoMatch[1]}?autoplay=1" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
   } else {
      container.innerHTML = `<video src="${url}" controls autoplay playsinline></video>`;
   }
   
   modal.classList.add('open');
};

window.closeWatchModal = function() {
   const modal = document.getElementById('zw-watch-modal');
   if(modal) {
      modal.classList.remove('open');
      document.getElementById('zw-wm-container').innerHTML = ''; // stops playback
   }
};
