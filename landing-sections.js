/* ───────────────────────────────────────────────────────────────────────────
   landing-sections.js — renders builder "Content" sections on landing pages.

   The homepage renders these same section types inside storefront.js (the
   SOURCE OF TRUTH for markup). Landing pages don't load storefront.js, so this
   is a self-contained mirror that renders the GENERIC, self-building section
   types (the ones useful for a category highlights page) into a host element.
   Homepage-template-bound types (hero/marquee/about-with-stats/release/products)
   that update pre-existing index.html markup are re-implemented generically
   here. If you change a section's markup in storefront.js, mirror it here.

   Exposes: window.ZWLandingSections.render(hostEl, sectionsArray)
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  // Per-device scrollbar prefs (show|hover|off + thin|medium|thick) → data-bar-*
  // on the .zw-swipe-wrap. Mirror of the homepage helper; back-compat maps the
  // legacy boolean bar_hover to desktop reveal-on-hover.
  window.zwApplyScrollbarPrefs = window.zwApplyScrollbarPrefs || function (wrap, cfg) {
    if (!wrap || !cfg) return;
    var m = function (v, d) { return (v === 'show' || v === 'hover' || v === 'off') ? v : d; };
    wrap.setAttribute('data-bar-lg', m(cfg.bar_lg, cfg.bar_hover ? 'hover' : 'show'));
    wrap.setAttribute('data-bar-md', m(cfg.bar_md, 'show'));
    wrap.setAttribute('data-bar-sm', m(cfg.bar_sm, 'show'));
    wrap.setAttribute('data-bar-size', (cfg.bar_size === 'medium' || cfg.bar_size === 'thick') ? cfg.bar_size : 'thin');
    wrap.classList.remove('zw-bar-hover');
  };

  // Per-device grid/swipe layout setter — mirror of the homepage helper (landing
  // pages don't load storefront.js). Writes data-lg/md/sm + --col-* + snap + hover.
  window.zwApplyPlatLayout = window.zwApplyPlatLayout || function (grid, cfg) {
    if (!grid || !cfg) return;
    grid.classList.add('zw-plat-grid');
    var mode = function (v, d) { return (v === 'swipe' || v === 'grid') ? v : d; };
    grid.setAttribute('data-lg', mode(cfg.lay_lg, 'grid'));
    grid.setAttribute('data-md', mode(cfg.lay_md, 'grid'));
    grid.setAttribute('data-sm', mode(cfg.lay_sm, 'swipe'));
    var sn = function (v) { return v === 'snap' ? 'on' : 'off'; };
    grid.setAttribute('data-snap-lg', sn(cfg.snap_lg));
    grid.setAttribute('data-snap-md', sn(cfg.snap_md));
    grid.setAttribute('data-snap-sm', sn(cfg.snap_sm));
    var col = function (v, fb) { var n = parseInt(v, 10); return (n >= 1 && n <= 6) ? n : fb; };
    grid.style.setProperty('--col-lg', col(cfg.col_lg, col(cfg.columns, 3)));
    grid.style.setProperty('--col-md', col(cfg.col_md, 2));
    grid.style.setProperty('--col-sm', col(cfg.col_sm, 2));
    if (window.zwEnsureSwipeBar) window.zwEnsureSwipeBar(grid);
    var w = grid.closest('.zw-swipe-wrap');
    if (w) window.zwApplyScrollbarPrefs(w, cfg);
  };

  // Nike-style draggable swipe scrollbar — mirror of the homepage helper (landing
  // pages don't load storefront.js). Shows only when the grid is horizontally
  // scrollable (swipe / individual-products mode). See .zw-swipe-* CSS.
  window.zwEnsureSwipeBar = window.zwEnsureSwipeBar || function (grid) {
    if (!grid || !grid.parentNode) return;
    var wrap = grid.closest('.zw-swipe-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'zw-swipe-wrap'; grid.parentNode.insertBefore(wrap, grid); wrap.appendChild(grid); }
    var bar = wrap.querySelector(':scope > .zw-swipe-bar'), thumb;
    if (!bar) { bar = document.createElement('div'); bar.className = 'zw-swipe-bar'; thumb = document.createElement('div'); thumb.className = 'zw-swipe-thumb'; bar.appendChild(thumb); wrap.appendChild(bar); }
    else { thumb = bar.querySelector('.zw-swipe-thumb'); }
    var sync = function () {
      var sw = grid.scrollWidth, cw = grid.clientWidth, max = sw - cw, scrollable = max > 4;
      wrap.classList.toggle('zw-has-swipe', scrollable);
      if (!scrollable) return;
      var tw = Math.max((cw / sw) * 100, 8);
      thumb.style.width = tw + '%';
      thumb.style.left = ((max > 0 ? grid.scrollLeft / max : 0) * (100 - tw)) + '%';
    };
    if (!grid._zwBarBound) {
      grid.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync, { passive: true });
      // Reveal-while-scrolling for "hover" mode on touch (see .zw-bar-scrolling CSS).
      var _barScrollT;
      grid.addEventListener('scroll', function () {
        wrap.classList.add('zw-bar-scrolling');
        clearTimeout(_barScrollT);
        _barScrollT = setTimeout(function () { wrap.classList.remove('zw-bar-scrolling'); }, 900);
      }, { passive: true });
      var dragging = false, startX = 0, startLeft = 0;
      thumb.addEventListener('pointerdown', function (e) { dragging = true; startX = e.clientX; startLeft = grid.scrollLeft; thumb.classList.add('zw-dragging'); try { thumb.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); });
      thumb.addEventListener('pointermove', function (e) { if (!dragging) return; var travel = bar.clientWidth - thumb.offsetWidth, max = grid.scrollWidth - grid.clientWidth; if (travel > 0) grid.scrollLeft = startLeft + ((e.clientX - startX) / travel) * max; });
      var end = function (e) { if (!dragging) return; dragging = false; thumb.classList.remove('zw-dragging'); try { thumb.releasePointerCapture(e.pointerId); } catch (_) {} };
      thumb.addEventListener('pointerup', end); thumb.addEventListener('pointercancel', end);
      bar.addEventListener('pointerdown', function (e) { if (e.target === thumb) return; var r = bar.getBoundingClientRect(); grid.scrollTo({ left: ((e.clientX - r.left) / r.width) * (grid.scrollWidth - grid.clientWidth), behavior: 'smooth' }); });
      grid._zwBarBound = true;
    }
    requestAnimationFrame(sync); setTimeout(sync, 350);
  };
  function optImg(u, w) { try { return (typeof window.optimizeImage === 'function') ? window.optimizeImage(u, w) : u; } catch (_) { return u; } }
  function safeUrl(u) { try { return (typeof window.zwSafeUrl === 'function') ? window.zwSafeUrl(u) : (u || '#'); } catch (_) { return u || '#'; } }
  function isVideoUrl(u) { return u && /\.(mp4|webm|mov)(\?.*)?$/i.test(u); }

  // Per-section font overrides — mirrors storefront.js _FONT_STACKS/_FONT_URLS so
  // a section's Heading/Body font choice actually applies on landing pages too.
  var FONT_STACKS = {
    'barlow-condensed':"'Barlow Condensed',sans-serif",'oswald':"'Oswald',sans-serif",'bebas-neue':"'Bebas Neue',sans-serif",
    'anton':"'Anton',sans-serif",'league-gothic':"'League Gothic',sans-serif",'michroma':"'Michroma',sans-serif",
    'montserrat':"'Montserrat',sans-serif",'syne':"'Syne',sans-serif",'archivo-black':"'Archivo Black',sans-serif",
    'teko':"'Teko',sans-serif",'righteous':"'Righteous',display",'playfair-display':"'Playfair Display',serif",
    'cinzel':"'Cinzel',serif",'futura':'"Futura", "Jost", sans-serif','futura-100-bold':'"Futura 100 Bold", "Futura", "Jost", sans-serif',
    'futura-100-bold-oblique':'"Futura 100 Bold Oblique", "Futura", "Jost", sans-serif','barlow':"'Barlow',sans-serif",
    'inter':"'Inter',sans-serif",'dm-sans':"'DM Sans',sans-serif",'outfit':"'Outfit',sans-serif",'manrope':"'Manrope',sans-serif",
    'poppins':"'Poppins',sans-serif",'lato':"'Lato',sans-serif",'roboto':"'Roboto',sans-serif",'work-sans':"'Work Sans',sans-serif",'mulish':"'Mulish',sans-serif"
  };
  var FONT_URLS = {
    'oswald':'https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap','bebas-neue':'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
    'anton':'https://fonts.googleapis.com/css2?family=Anton&display=swap','league-gothic':'https://fonts.googleapis.com/css2?family=League+Gothic&display=swap',
    'michroma':'https://fonts.googleapis.com/css2?family=Michroma&display=swap','montserrat':'https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,700;0,800;0,900;1,700;1,800;1,900&display=swap',
    'syne':'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&display=swap','archivo-black':'https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap',
    'teko':'https://fonts.googleapis.com/css2?family=Teko:wght@600;700&display=swap','righteous':'https://fonts.googleapis.com/css2?family=Righteous&display=swap',
    'playfair-display':'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;0,900;1,700;1,800;1,900&display=swap','cinzel':'https://fonts.googleapis.com/css2?family=Cinzel:wght@700;800;900&display=swap',
    'futura':'https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,600;1,700&display=swap',
    'futura-100-bold':'https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,600;1,700&display=swap',
    'futura-100-bold-oblique':'https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,600;1,700&display=swap',
    'inter':'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap','dm-sans':'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap',
    'outfit':'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap','manrope':'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap',
    'poppins':'https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap','lato':'https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,300;0,400;0,700;1,400&display=swap',
    'roboto':'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;1,400&display=swap','work-sans':'https://fonts.googleapis.com/css2?family=Work+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap',
    'mulish':'https://fonts.googleapis.com/css2?family=Mulish:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap'
  };
  function loadFont(key) {
    if (!key || !FONT_URLS[key] || document.getElementById('gf-' + key)) return;
    var l = document.createElement('link'); l.id = 'gf-' + key; l.rel = 'preload'; l.as = 'style'; l.href = FONT_URLS[key];
    l.onload = function () { this.onload = null; this.rel = 'stylesheet'; };
    document.head.appendChild(l);
  }
  function ctaBtn(text, url, style) {
    var base = 'display:inline-block;padding:.85rem 2rem;font-family:var(--fm,var(--fb));font-size:.66rem;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;';
    if (style === 'solid') base += 'background:#fff;color:#09090b;border:1px solid #fff;';
    else if (style === 'ghost') base += 'background:transparent;color:#fff;border:none;text-decoration:underline;text-underline-offset:4px;';
    else base += 'background:transparent;color:#fff;border:1px solid #fff;';
    return '<a href="' + safeUrl(url) + '" style="' + base + '">' + text + '</a>';
  }

  // Minimal "Watch" video modal if the page doesn't already provide one.
  if (typeof window.openWatchModal !== 'function') {
    window.openWatchModal = function (url) {
      if (!url) return;
      var yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
      var vm = url.match(/vimeo\.com\/(\d+)/);
      var inner;
      if (yt) inner = '<iframe src="https://www.youtube.com/embed/' + yt[1] + '?autoplay=1" style="width:100%;height:100%;border:none" allow="autoplay;fullscreen" allowfullscreen></iframe>';
      else if (vm) inner = '<iframe src="https://player.vimeo.com/video/' + vm[1] + '?autoplay=1" style="width:100%;height:100%;border:none" allow="autoplay;fullscreen" allowfullscreen></iframe>';
      else inner = '<video src="' + url + '" controls autoplay playsinline style="width:100%;height:100%;background:#000"></video>';
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:4vmin';
      ov.innerHTML = '<div style="position:relative;width:min(960px,100%);aspect-ratio:16/9">' + inner +
        '<button aria-label="Close" style="position:absolute;top:-2.4rem;right:0;background:none;border:none;color:#fff;font-size:1.6rem;cursor:pointer">×</button></div>';
      ov.addEventListener('click', function (e) { if (e.target === ov || e.target.tagName === 'BUTTON') ov.remove(); });
      document.body.appendChild(ov);
    };
  }

  // Universal "Section Style" overrides — mirrors storefront.js tail.
  function applyTail(el, s, secId) {
    if (s.anchor_id) el.id = s.anchor_id;
    if (s.sec_bg) el.style.setProperty('background', s.sec_bg, 'important');
    if (s.pad_top) el.style.paddingTop = s.pad_top + 'px';
    if (s.pad_bot) el.style.paddingBottom = s.pad_bot + 'px';
    if (s.text_color) el.style.setProperty('color', s.text_color, 'important');
    if (s.heading_size) el.querySelectorAll('h1,h2,[data-builder-heading]').forEach(function (h) { h.style.setProperty('font-size', s.heading_size, 'important'); });
    var idSel = s.anchor_id || secId;
    if (s.hide_mobile) addHideStyle('zw-lp-mh-' + idSel, '@media(max-width:900px){#' + idSel + '{display:none!important;}}');
    if (s.hide_desktop) addHideStyle('zw-lp-dh-' + idSel, '@media(min-width:901px){#' + idSel + '{display:none!important;}}');
    if (s.font_head_override && FONT_STACKS[s.font_head_override]) {
      el.style.setProperty('--zw-font-head', FONT_STACKS[s.font_head_override]);
      el.style.setProperty('--fw', FONT_STACKS[s.font_head_override]);
      loadFont(s.font_head_override);
    }
    if (s.font_body_override && FONT_STACKS[s.font_body_override]) {
      el.style.setProperty('--zw-font-body', FONT_STACKS[s.font_body_override]);
      el.style.setProperty('--fb', FONT_STACKS[s.font_body_override]);
      loadFont(s.font_body_override);
    }
  }
  function addHideStyle(id, css) {
    var st = document.getElementById(id);
    if (!st) { st = document.createElement('style'); st.id = id; document.head.appendChild(st); }
    st.textContent = css;
  }

  // ── Per-type markup (mirrors storefront.js). Returns false if unsupported. ──
  function renderBody(el, sec, s) {
    switch (sec.type) {
      case 'hero': {
        el.className = 'builder-hero-section';
        var fit = s.fit === 'contain' ? 'contain' : 'cover';
        var ov = (s.overlay_opacity != null ? s.overlay_opacity : 40) / 100;
        var align = s.text_align || 'left';
        var img = s.image || '';
        el.style.cssText = 'position:relative;min-height:88vh;display:flex;flex-direction:column;justify-content:flex-end;padding:clamp(2rem,6vw,5rem);overflow:hidden;background:' + (s.bg_color || '#09090b') + ';text-align:' + align + ';';
        var wrapMargin = align === 'center' ? 'margin:0 auto;' : align === 'right' ? 'margin-left:auto;' : '';
        var btnJustify = align === 'center' ? 'justify-content:center;' : align === 'right' ? 'justify-content:flex-end;' : '';
        // Viewfinder framing: focal point → object-position on the tablet/mobile
        // breakpoints (see .builder-hero-section img CSS in storefront-cohesion.css).
        var _pos = function (f) { return (f && f.x != null && f.y != null) ? (f.x + '% ' + f.y + '%') : ''; };
        var _posVars = '';
        if (_pos(s.focalTab)) _posVars += '--zwh-pos-tab:' + _pos(s.focalTab) + ';';
        if (_pos(s.focalMob)) _posVars += '--zwh-pos-mob:' + _pos(s.focalMob) + ';';
        el.innerHTML =
          (img ? '<img src="' + optImg(img, 1600) + '" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:' + fit + ';z-index:0;' + _posVars + '">' : '') +
          '<div style="position:absolute;inset:0;background:rgba(9,9,11,' + ov + ');z-index:1"></div>' +
          '<div style="position:relative;z-index:2;max-width:760px;' + wrapMargin + '">' +
          ((s.show_kicker !== false && s.kicker) ? '<p style="font-family:var(--fm,var(--fb));font-size:.7rem;letter-spacing:.3em;text-transform:uppercase;opacity:.85;margin-bottom:1rem;color:#fff">' + s.kicker + '</p>' : '') +
          (s.heading ? '<h1 style="font-family:var(--fw);font-weight:900;font-style:italic;text-transform:uppercase;line-height:.92;font-size:clamp(2.6rem,8vw,5.5rem);color:#fff;margin:0 0 1rem">' + String(s.heading).replace(/\n/g, '<br>') + '</h1>' : '') +
          ((s.show_subtext !== false && s.subtext) ? '<p style="font-family:var(--fb);font-size:1.05rem;opacity:.85;color:#fff;max-width:46ch;' + (align === 'center' ? 'margin:0 auto 1.6rem;' : 'margin:0 0 1.6rem;') + 'line-height:1.5">' + s.subtext + '</p>' : '') +
          '<div style="display:flex;gap:.8rem;flex-wrap:wrap;' + btnJustify + '">' +
          (s.cta1_text ? ctaBtn(s.cta1_text, s.cta1_url, s.cta1_style || 'outline') : '') +
          ((s.cta2_on && s.cta2_text) ? ctaBtn(s.cta2_text, s.cta2_url, 'ghost') : '') +
          '</div></div>' +
          ((s.img_btn_on && s.img_btn_text) ? '<a href="' + safeUrl(s.img_btn_url) + '" style="position:absolute;bottom:30%;left:50%;transform:translateX(-50%);z-index:3;padding:.65rem 1.8rem;background:rgba(255,255,255,.92);color:#09090b;font-family:var(--fm,var(--fb));font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;text-decoration:none">' + s.img_btn_text + '</a>' : '');
        return true;
      }
      case 'spacer': {
        el.className = 'builder-spacer';
        el.style.height = ({ xs: '1rem', sm: '2rem', md: '4rem', lg: '8rem', xl: '12rem' }[s.height] || '4rem');
        return true;
      }
      case 'marquee': {
        el.className = 'builder-marquee-section';
        el.style.cssText = 'overflow:hidden;padding:1.1rem 0;border-top:1px solid rgba(244,241,235,.08);border-bottom:1px solid rgba(244,241,235,.08);white-space:nowrap';
        var items = String(s.items || '').split(',').map(function (i) { return i.trim(); }).filter(Boolean);
        var dur = ({ slow: '40s', normal: '26s', fast: '15s' }[s.speed] || '26s');
        var row = items.concat(items).map(function (i) { return '<span style="font-family:var(--fw);font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:.05em;font-size:1.4rem;margin:0 1.4rem">' + i + '</span><span style="color:var(--gold);margin:0 1.4rem">&#10022;</span>'; }).join('');
        el.innerHTML = '<div style="display:inline-block;animation:zwLpMarquee ' + dur + ' linear infinite">' + row + '</div>';
        ensureMarqueeKeyframes();
        return true;
      }
      case 'about': {
        el.className = 'builder-about-section';
        el.style.cssText = 'padding:5rem 2.5rem;max-width:1000px;margin:0 auto;text-align:center';
        var stats = Array.isArray(s.stats) ? s.stats : [];
        el.innerHTML =
          (s.label ? '<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.5;margin-bottom:1rem">' + s.label + '</div>' : '') +
          (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(1.8rem,5vw,3rem);font-weight:900;font-style:italic;letter-spacing:.04em;text-transform:uppercase;line-height:1.05;margin-bottom:1.4rem">' + String(s.heading).replace(/\n/g, '<br>') + '</h2>' : '') +
          (s.body ? '<div style="opacity:.7;line-height:1.8;font-size:1rem;max-width:620px;margin:0 auto;white-space:pre-line">' + s.body + '</div>' : '') +
          (stats.length ? '<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:2.5rem;margin-top:2.6rem">' + stats.map(function (st) { return '<div><div style="font-family:var(--fw);font-size:clamp(2rem,6vw,3rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">' + (st.value || '') + '</div><div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.5;margin-top:.4rem">' + (st.label || '') + '</div></div>'; }).join('') + '</div>' : '');
        return true;
      }
      case 'text': {
        el.className = 'builder-text-section';
        el.style.cssText = 'padding:4rem 2.5rem;max-width:800px;margin:0 auto;text-align:' + (s.align || 'left');
        el.innerHTML =
          (s.heading ? '<h2 data-builder-heading style="font-family:var(--fw);font-size:2.2rem;text-transform:uppercase;margin-bottom:1.2rem;letter-spacing:.08em;font-weight:900;font-style:italic">' + s.heading + '</h2>' : '') +
          (s.body ? '<p data-builder-body style="font-family:var(--fb);font-size:1.05rem;opacity:.75;line-height:1.75;margin-bottom:1.6rem;white-space:pre-line">' + s.body + '</p>' : '') +
          (s.cta_text ? '<a class="btn-outline" href="' + safeUrl(s.cta_url) + '" style="display:inline-block;padding:.65rem 1.6rem;border:1px solid currentColor;font-family:var(--fm);font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;text-decoration:none">' + s.cta_text + '</a>' : '');
        return true;
      }
      case 'richtext': {
        el.className = 'builder-richtext-section';
        el.style.cssText = 'padding:4rem 2.5rem;max-width:760px;margin:0 auto;text-align:' + (s.align || 'left');
        el.innerHTML = '<div data-builder-body style="line-height:1.85;font-size:1rem;opacity:.85;white-space:pre-line">' + (s.content || '') + '</div>';
        return true;
      }
      case 'html': {
        el.className = 'builder-custom-section';
        el.innerHTML = s.html || '';
        return true;
      }
      case 'header': {
        el.className = 'builder-header-section';
        el.style.cssText = 'padding:1.4rem 2.5rem;max-width:1400px;margin:0 auto';
        var hl = s.show_line !== false;
        var above = s.line_position === 'above';
        var rule = hl ? '1px solid rgba(128,128,128,.32)' : 'none';
        el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem;' + (above ? 'border-top' : 'border-bottom') + ':' + rule + ';padding:' + (above ? '.9rem 0 0' : '0 0 .9rem') + '">' +
          '<span style="font-family:var(--fm,var(--fb));font-size:.7rem;letter-spacing:.14em;text-transform:uppercase">' + (s.left || '') + '</span>' +
          (s.right ? '<span style="font-family:var(--fm,var(--fb));font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;opacity:.45">' + s.right + '</span>' : '') +
          '</div>';
        return true;
      }
      case 'cta': {
        el.className = 'builder-cta-section';
        var ctaAlign = s.align || 'center';
        el.style.cssText = 'padding:6rem 2.5rem;text-align:' + ctaAlign + ';background:' + (s.bg_color || s.sec_bg || 'transparent') + ';color:' + (s.text_color || 'inherit');
        el.innerHTML = '<div style="max-width:700px;margin:0 auto">' +
          (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(2rem,6vw,3.2rem);font-weight:900;font-style:italic;letter-spacing:.08em;text-transform:uppercase;line-height:1.05;margin-bottom:1rem">' + s.heading + '</h2>' : '') +
          (s.subtext ? '<p style="opacity:.65;line-height:1.7;margin-bottom:2rem;font-size:1rem">' + s.subtext + '</p>' : '') +
          (s.btn_text ? '<a href="' + safeUrl(s.btn_url) + '" style="display:inline-block;background:' + (s.btn_style === 'solid' ? 'currentColor' : 'transparent') + ';color:' + (s.btn_style === 'solid' ? (s.sec_bg || s.bg_color || '#09090b') : 'currentColor') + ';border:1px solid currentColor;padding:.75rem 2rem;font-family:var(--fm,var(--fb));font-size:.7rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;text-decoration:none">' + s.btn_text + '</a>' : '') +
          '</div>';
        return true;
      }
      case 'color_block': {
        el.className = 'builder-color-block-section';
        var cbBg = s.bg_color || '#1f2937';
        var cbLight = (function (c) { // small luminance check (mirrors storefront _zwIsLightColor)
          var m = String(c || '').trim().match(/^#([0-9a-f]{6})$/i);
          if (!m) return false;
          var r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150;
        })(cbBg);
        var cbTxt = s.text_color || (cbLight ? '#09090b' : '#f4f1eb');
        var cbW = s.width || 'full';
        var cbBlockW = cbW === 'full' ? '100%' : (cbW === 'half' ? '50%' : cbW + 'px');
        var cbMar = ({ left: '0 auto 0 0', right: '0 0 0 auto' })[s.block_align] || '0 auto';
        var cbPad = ({ sm: '2.5rem 1.5rem', md: '4rem 2.5rem', lg: '6rem 3rem', xl: '8rem 3.5rem' })[s.inner_pad || 'md'] || '4rem 2.5rem';
        var cbAlign = s.content_align || 'center';
        var cbJust = cbAlign === 'left' ? 'flex-start' : (cbAlign === 'right' ? 'flex-end' : 'center');
        el.style.cssText = 'padding:0 ' + ((cbW === 'full' || cbW === 'half') ? '0' : '2.5rem') + ';margin-top:' + (parseInt(s.gap_top) || 0) + 'px;margin-bottom:' + (parseInt(s.gap_bot) || 0) + 'px';
        var cbEsc = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        var cbBtnHtml = (Array.isArray(s.buttons) ? s.buttons : []).filter(function (b) { return b && b.text; }).map(function (b) {
          var st = b.style || 'solid';
          var css = 'display:inline-block;padding:.75rem 2rem;font-family:var(--fm,var(--fb));font-size:.7rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;';
          if (st === 'solid') css += 'background:' + cbTxt + ';color:' + cbBg + ';border:1px solid ' + cbTxt + ';';
          else if (st === 'outline') css += 'background:transparent;color:inherit;border:1px solid currentColor;';
          else css += 'background:transparent;color:inherit;border:none;text-decoration:underline;text-underline-offset:4px;';
          return '<a href="' + cbEsc(safeUrl(b.url)) + '" style="' + css + '">' + cbEsc(b.text) + '</a>';
        }).join('');
        el.innerHTML = '<div style="background:' + cbBg + ';color:' + cbTxt + ';max-width:' + cbBlockW + ';margin:' + cbMar + ';padding:' + cbPad + ';border-radius:' + (parseInt(s.radius) || 0) + 'px;' + (s.min_height ? 'min-height:' + parseInt(s.min_height) + 'px;' : '') + 'text-align:' + cbAlign + ';display:flex;flex-direction:column;justify-content:center">' +
          (s.eyebrow ? '<div style="font-family:var(--fm,var(--fb));font-size:.62rem;letter-spacing:.22em;text-transform:uppercase;opacity:.65;margin-bottom:1rem">' + s.eyebrow + '</div>' : '') +
          (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(1.8rem,5vw,2.8rem);font-weight:900;font-style:italic;letter-spacing:.06em;text-transform:uppercase;line-height:1.05;margin:0 0 1rem">' + String(s.heading).replace(/\n/g, '<br>') + '</h2>' : '') +
          (s.body ? '<p style="opacity:.75;line-height:1.75;font-size:1rem;margin:0 0 ' + (cbBtnHtml ? '1.8rem' : '0') + ';white-space:pre-line;font-family:var(--fb)">' + s.body + '</p>' : '') +
          (cbBtnHtml ? '<div style="display:flex;gap:.8rem;flex-wrap:wrap;justify-content:' + cbJust + '">' + cbBtnHtml + '</div>' : '') +
          '</div>';
        return true;
      }
      case 'banner': {
        el.className = 'builder-banner-section';
        el.style.cssText = 'padding:1.5rem 2.5rem;text-align:center;background:' + (s.bg_color || s.sec_bg || '#09090b') + ';color:' + (s.text_color || '#f4f1eb');
        el.innerHTML = '<span style="font-family:var(--fm,var(--fb));font-size:.8rem;letter-spacing:.12em;text-transform:uppercase">' + (s.text || '') + '</span>' +
          (s.link_text ? ' <a href="' + safeUrl(s.link_url) + '" style="color:inherit;margin-left:.75rem;text-decoration:underline;font-family:var(--fm,var(--fb));font-size:.8rem;letter-spacing:.12em;text-transform:uppercase">' + s.link_text + '</a>' : '');
        return true;
      }
      case 'features': {
        el.className = 'builder-features-section';
        el.style.cssText = 'padding:5rem 2.5rem;text-align:center';
        var fitems = s.items || [];
        el.innerHTML = (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(1.6rem,4vw,2.4rem);letter-spacing:.08em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:3rem">' + s.heading + '</h2>' : '') +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:2rem;max-width:1000px;margin:0 auto">' +
          fitems.map(function (it) { return '<div style="padding:1.5rem"><div style="font-size:2rem;margin-bottom:1rem">' + (it.icon || '') + '</div><div style="font-family:var(--fw);font-size:1rem;font-weight:700;font-style:italic;letter-spacing:.06em;text-transform:uppercase;margin-bottom:.6rem">' + (it.title || '') + '</div><div style="opacity:.6;font-size:.88rem;line-height:1.6">' + (it.desc || '') + '</div></div>'; }).join('') +
          '</div>';
        return true;
      }
      case 'testimonials': {
        el.className = 'builder-testimonials-section';
        el.style.cssText = 'padding:5rem 2.5rem;text-align:center';
        var titems = s.items || [];
        el.innerHTML = (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(1.6rem,4vw,2.4rem);letter-spacing:.08em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:3rem">' + s.heading + '</h2>' : '') +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:2rem;max-width:1000px;margin:0 auto">' +
          titems.map(function (it) { var r = Math.min(5, Math.max(1, parseInt(it.rating) || 5)); return '<div style="background:rgba(244,241,235,.04);border:1px solid rgba(244,241,235,.08);padding:2rem;text-align:left"><div style="color:var(--gold);margin-bottom:1rem;font-size:1.1rem">' + '★'.repeat(r) + '</div><p style="line-height:1.7;margin-bottom:1.2rem;opacity:.8;font-size:.95rem">"' + (it.quote || '') + '"</p><div style="font-family:var(--fw);font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;opacity:.5">' + (it.author || '') + '</div></div>'; }).join('') +
          '</div>';
        return true;
      }
      case 'numbers': {
        el.className = 'builder-numbers-section';
        el.style.cssText = 'padding:5rem 2.5rem;text-align:center';
        var nitems = s.items || [];
        el.innerHTML = (s.heading ? '<h2 data-builder-heading style="font-family:var(--fw);font-size:clamp(1.4rem,4vw,1.8rem);letter-spacing:.1em;text-transform:uppercase;margin-bottom:2.5rem;font-weight:700;font-style:italic">' + s.heading + '</h2>' : '') +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:2rem;max-width:900px;margin:0 auto">' +
          nitems.map(function (it) { return '<div><div style="font-family:var(--fw);font-size:clamp(2.5rem,8vw,4rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">' + (it.value || '') + '</div><div style="font-family:var(--fm,var(--fb));font-size:.65rem;letter-spacing:.2em;text-transform:uppercase;opacity:.55;margin-top:.5rem">' + (it.label || '') + '</div></div>'; }).join('') +
          '</div>';
        return true;
      }
      case 'press': {
        el.className = 'builder-press-section';
        el.style.cssText = 'padding:3.5rem 2.5rem;text-align:center;border-top:1px solid rgba(244,241,235,.08);border-bottom:1px solid rgba(244,241,235,.08)';
        var pritems = s.items || [];
        el.innerHTML = (s.heading ? '<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-bottom:1.5rem">' + s.heading + '</div>' : '') +
          '<div style="display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:2rem 3rem">' +
          pritems.map(function (it) { return '<span style="font-family:var(--fw);font-size:1.4rem;font-weight:700;font-style:italic;letter-spacing:.08em;text-transform:uppercase;opacity:.5">' + (it.name || '') + '</span>'; }).join('') +
          '</div>';
        return true;
      }
      case 'logos': {
        el.className = 'builder-logos-section' + (s.logo_original ? ' logo-original' : '');
        el.style.cssText = 'padding:2.5rem 2.5rem;text-align:center';
        var logositems = s.items || [];
        var logoH = s.logo_height || 28;
        var imgFilter = s.logo_original ? '' : 'filter:brightness(0) invert(1);';
        var imgOp = s.logo_original ? '1' : '.45';
        var spanOp = s.logo_original ? '.75' : '.35';
        el.innerHTML = (s.heading ? '<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.35;margin-bottom:1.2rem">' + s.heading + '</div>' : '') +
          '<div style="display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:1.5rem 2.5rem">' +
          logositems.map(function (it) {
            var inner = it.src ? '<img src="' + it.src + '" alt="' + (it.alt || it.name || '') + '" style="height:' + logoH + 'px;width:auto;opacity:' + imgOp + ';' + imgFilter + '">'
              : it.name ? '<span style="font-family:var(--fw);font-size:1.1rem;font-weight:700;font-style:italic;letter-spacing:.06em;text-transform:uppercase;opacity:' + spanOp + '">' + it.name + '</span>' : '';
            if (!inner) return '';
            return it.link ? '<a class="zw-logo-link" href="' + safeUrl(it.link) + '" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit">' + inner + '</a>' : inner;
          }).join('') +
          '</div>';
        return true;
      }
      case 'faq': {
        el.className = 'builder-faq-section';
        el.style.cssText = 'padding:5rem 2.5rem';
        var faqitems = s.items || [];
        el.innerHTML = '<div style="max-width:800px;margin:0 auto">' +
          (s.heading ? '<h2 data-builder-heading style="font-family:var(--fw);font-size:clamp(1.6rem,5vw,2.4rem);letter-spacing:.08em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:2rem">' + s.heading + '</h2>' : '') +
          '<div style="border-top:1px solid rgba(244,241,235,.12)">' +
          faqitems.map(function (it) { return '<details style="border-bottom:1px solid rgba(244,241,235,.12)"><summary style="padding:1.1rem 0;cursor:pointer;font-family:var(--fw);font-size:1rem;letter-spacing:.04em;list-style:none;display:flex;justify-content:space-between;align-items:center">' + (it.q || '') + '<span style="font-size:.8rem;opacity:.4;flex-shrink:0;margin-left:.5rem">+</span></summary><div style="padding:0 0 1.2rem;opacity:.65;line-height:1.7;font-size:.9rem">' + (it.a || '') + '</div></details>'; }).join('') +
          '</div></div>';
        return true;
      }
      case 'email_capture': {
        el.className = 'builder-email-capture-section';
        el.style.cssText = 'padding:6rem 2.5rem;text-align:center;background:' + (s.bg_color || s.sec_bg || 'transparent');
        el.innerHTML = '<div style="max-width:520px;margin:0 auto">' +
          (s.heading ? '<h2 data-builder-heading style="font-family:var(--fw);font-size:clamp(1.8rem,5vw,2.6rem);letter-spacing:.1em;text-transform:uppercase;font-weight:900;font-style:italic;margin-bottom:.75rem">' + s.heading + '</h2>' : '') +
          (s.subtext ? '<p style="opacity:.6;margin-bottom:1.8rem;line-height:1.6;font-size:.95rem">' + s.subtext + '</p>' : '') +
          '<div style="display:flex;gap:.5rem;max-width:400px;margin:0 auto"><input type="email" placeholder="' + (s.placeholder || 'your@email.com') + '" style="flex:1;background:rgba(244,241,235,.06);border:1px solid rgba(244,241,235,.15);color:inherit;padding:.75rem 1rem;font-family:var(--fb);font-size:.9rem;outline:none"><button style="background:var(--paper,#f4f1eb);color:var(--ink,#09090b);border:none;padding:.75rem 1.4rem;font-family:var(--fw);font-size:.8rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;white-space:nowrap">' + (s.btn_text || 'Join') + '</button></div></div>';
        return true;
      }
      case 'video': {
        el.className = 'builder-video-section';
        el.style.cssText = 'padding:3rem 2.5rem;max-width:900px;margin:0 auto';
        var url = s.url || '';
        var ytM = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
        var vmM = url.match(/vimeo\.com\/(\d+)/);
        var vsrc = '';
        if (ytM) { var p = new URLSearchParams({ rel: '0' }); if (s.autoplay) p.set('autoplay', '1'); if (s.muted) p.set('mute', '1'); if (!s.controls) p.set('controls', '0'); vsrc = 'https://www.youtube.com/embed/' + ytM[1] + '?' + p; }
        else if (vmM) { vsrc = 'https://player.vimeo.com/video/' + vmM[1]; }
        el.innerHTML = vsrc
          ? '<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden"><iframe src="' + vsrc + '" style="position:absolute;inset:0;width:100%;height:100%;border:none" allowfullscreen allow="autoplay"></iframe></div>' + (s.caption ? '<p style="text-align:center;opacity:.45;font-size:.8rem;margin-top:1rem">' + s.caption + '</p>' : '')
          : '<div style="background:rgba(244,241,235,.05);border:1px dashed rgba(244,241,235,.15);padding:4rem;text-align:center;opacity:.4;font-size:.8rem">Add a YouTube or Vimeo URL</div>';
        return true;
      }
      case 'gallery': {
        el.className = 'builder-gallery-section';
        var gFull = !s.layout_width || s.layout_width === 'full';
        var gpx = gFull ? '0' : '2.5rem';
        var gmw = gFull ? 'none' : (s.layout_width === 'contained' ? '1200px' : s.layout_width + 'px');
        el.style.cssText = 'padding:3rem 0;';
        var gcols = parseInt(s.columns) || 3;
        var gAspect = ({ square: '1/1', portrait: '3/4', wide: '16/9' }[s.aspect] || '1/1');
        var gimgs = Array.isArray(s.images) ? s.images : [];
        if (!gimgs.length) { el.innerHTML = '<div style="padding:0 ' + gpx + ';max-width:' + gmw + ';margin:0 auto;"><div style="opacity:.5;text-align:center">Add images to gallery</div></div>'; return true; }
        el.innerHTML = '<div style="padding:0 ' + gpx + ';max-width:' + gmw + ';margin:0 auto;">' +
          (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(1.5rem,3vw,2.2rem);text-transform:uppercase;font-weight:800;font-style:italic;text-align:center;margin-bottom:2rem">' + s.heading + '</h2>' : '') +
          '<div class="zw-plat-grid" style="gap:1rem">' +
          gimgs.map(function (img) { return (img.link ? '<a href="' + safeUrl(img.link) + '"' : '<div') + ' style="aspect-ratio:' + gAspect + ';overflow:hidden;display:block"><img src="' + optImg(img.src, 1200) + '" alt="' + (img.alt || '') + '" style="width:100%;height:100%;object-fit:cover;transition:transform .4s ease" loading="lazy">' + (img.link ? '</a>' : '</div>'); }).join('') +
          '</div></div>';
        return true;
      }
      case 'split': {
        el.className = 'builder-split-section';
        var imgSide = s.image_side || 'left';
        var spFull = !s.layout_width || s.layout_width === 'full';
        var sppx = spFull ? '0' : '2.5rem';
        var spmw = spFull ? 'none' : (s.layout_width === 'contained' ? '1200px' : s.layout_width + 'px');
        el.style.cssText = 'background:' + (s.bg_color || s.sec_bg || 'transparent') + ';';
        var optSplit = s.image ? optImg(s.image, 1200) : s.image;
        var imgPart = s.image ? '<div style="flex:1 1 400px;min-height:' + (s.image_height || 500) + 'px;background:url(' + optSplit + ') center/cover no-repeat"></div>' : '';
        var txtPart = '<div style="flex:1 1 400px;padding:4rem 3rem">' + (s.label ? '<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.5;margin-bottom:1rem">' + s.label + '</div>' : '') + '<h2 style="font-family:var(--fw);font-size:clamp(1.8rem,4vw,2.8rem);font-weight:900;font-style:italic;letter-spacing:.06em;text-transform:uppercase;line-height:1.05;margin-bottom:1.2rem">' + (s.heading || '') + '</h2><p style="opacity:.65;line-height:1.75;font-size:.95rem;margin-bottom:1.8rem">' + (s.body || '') + '</p>' + (s.cta_text ? '<a href="' + safeUrl(s.cta_url) + '" style="display:inline-block;border:1px solid currentColor;padding:.65rem 1.6rem;font-family:var(--fm,var(--fb));font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;color:inherit">' + s.cta_text + '</a>' : '') + '</div>';
        var innerHTML = imgSide === 'left' ? (imgPart + txtPart) : (txtPart + imgPart);
        el.innerHTML = '<div style="display:flex;flex-wrap:wrap;align-items:center;min-height:' + (s.image_height || 500) + 'px;padding:0 ' + sppx + ';max-width:' + spmw + ';margin:0 auto;' + (!spFull && (s.sec_bg || s.bg_color) ? 'border-radius:12px;overflow:hidden;' : '') + '">' + innerHTML + '</div>';
        return true;
      }
      case 'img_cta': case 'image_cta': {
        el.className = 'builder-image-cta-section';
        el.style.cssText = 'position:relative;width:100%;min-height:420px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#09090b';
        var btnVis = s.btn_on !== undefined ? s.btn_on : s.btn_visible;
        var posMap = { center: 'center', 'bottom-left': 'flex-end;justify-content:flex-start', 'bottom-right': 'flex-end;justify-content:flex-end', 'top-right': 'flex-start;justify-content:flex-end' };
        el.innerHTML = '<img src="' + (s.image ? optImg(s.image, 1200) : '') + '" alt="' + (s.alt || '') + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;opacity:.55">' +
          (btnVis && s.btn_text ? '<div style="position:relative;z-index:2;text-align:center;padding:2rem"><a href="' + safeUrl(s.btn_url) + '" class="btn-outline" style="display:inline-block;padding:.8rem 2rem;border:1px solid #fff;color:#fff;font-family:var(--fm);font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;background:rgba(9,9,11,.45);backdrop-filter:blur(8px)">' + s.btn_text + '</a></div>' : '');
        return true;
      }
      case 'countdown': {
        el.className = 'builder-countdown-section';
        el.style.cssText = 'padding:5rem 2.5rem;text-align:' + (s.align || 'center');
        var cdId = 'lp-cd-' + sec.id;
        var unit = function (l) { return '<div><div class="cd-n" style="font-family:var(--fw);font-size:clamp(3rem,10vw,5rem);font-weight:900;font-style:italic;line-height:1;color:var(--gold)">--</div>' + (s.show_labels !== false ? '<div style="font-family:var(--fm,var(--fb));font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-top:.4rem">' + l + '</div>' : '') + '</div>'; };
        el.innerHTML = (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(1.4rem,4vw,2rem);letter-spacing:.1em;text-transform:uppercase;font-weight:700;font-style:italic;margin-bottom:2rem">' + s.heading + '</h2>' : '') +
          '<div id="' + cdId + '" style="display:flex;gap:2.5rem;justify-content:' + (s.align === 'left' ? 'flex-start' : 'center') + ';flex-wrap:wrap">' + unit('Days') + unit('Hours') + unit('Minutes') + unit('Seconds') + '</div>';
        return true;
      }
      case 'media_grid': return renderMediaGrid(el, s);
      case 'hero_carousel': return renderCarousel(el, s);
      default: return false; // hero/release/products are homepage-only
    }
  }

  function renderMediaGrid(el, s) {
    el.className = 'builder-media-grid-section';
    var full = !s.layout_width || s.layout_width === 'full';
    var px = full ? '0' : '2.5rem';
    var mw = full ? 'none' : (s.layout_width === 'contained' ? '1200px' : s.layout_width + 'px');
    el.style.cssText = 'background:' + (s.sec_bg || 'transparent');
    var cards = Array.isArray(s.cards) ? s.cards : [];
    if (!cards.length) { el.innerHTML = '<div style="padding:4rem ' + px + ';max-width:' + mw + ';margin:0 auto;text-align:center;opacity:0.5">Add cards in the editor</div>'; return true; }
    var layout = s.layout || 'grid';
    var gap = ({ none: '0', xs: '.5rem', sm: '1rem', md: '1.5rem', lg: '2.5rem' }[s.gap || 'md'] || '1.5rem');
    var aspect = ({ square: '1/1', portrait: '3/4', wide: '16/9', auto: 'auto' }[s.aspect || 'portrait'] || '3/4');
    // Layout handled by the per-device zw-plat-grid system (applied post-render).
    var trackClass = 'zw-mg-track zw-plat-grid', trackStyle = 'gap:' + gap + ';';
    var cardsHtml = cards.map(function (cd) {
      var tag = cd.link_url ? 'a' : 'div';
      var href = cd.link_url ? ' href="' + safeUrl(cd.link_url) + '"' : '';
      var pos = cd.label_position || 'below';
      var ht = s.card_height ? 'height:' + s.card_height + ';' : 'aspect-ratio:' + aspect + ';';
      var media = (cd.media_type === 'video' || isVideoUrl(cd.media_url))
        ? '<video src="' + (cd.media_url || '') + '" poster="' + (cd.video_poster || '') + '" playsinline autoplay loop muted class="zw-mg-media" style="' + ht + '"></video>'
        : '<img src="' + optImg(cd.media_url, 800) + '" alt="" class="zw-mg-media" style="' + ht + '" loading="lazy" decoding="async">';
      // Adidas-style card content: chip label + description + CTA button. Overlay
      // modes lay them over the image (gradient scrim); "below" stacks them under.
      var arrow = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      var _esc = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
      var lbl = cd.label ? _esc(cd.label) : '', sub = cd.sublabel ? _esc(cd.sublabel) : '', cta = cd.cta_text ? _esc(cd.cta_text) : '';
      var isOverlay = pos.indexOf('overlay') === 0;
      var watch = cd.watch_btn ? '<button class="zw-mg-watch" onclick="event.preventDefault(); openWatchModal(\'' + (cd.watch_url || '') + '\')"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> ' + (cd.watch_label || 'Watch') + '</button>' : '';
      var overlayHtml = '';
      if (isOverlay && (lbl || sub || cta)) {
        var chipCls = cd.label_boxed === false ? 'zw-mg-chip zw-mg-chip--plain' : 'zw-mg-chip';
        overlayHtml = '<div class="zw-mg-scrim"></div><div class="zw-mg-ov zw-mg-ov-' + pos.replace('overlay-', '') + '">' + (lbl ? '<span class="' + chipCls + '">' + lbl + '</span>' : '') + (sub ? '<p class="zw-mg-ovsub">' + sub + '</p>' : '') + (cta ? '<span class="zw-mg-btn">' + cta + arrow + '</span>' : '') + '</div>';
      }
      var belowHtml = '';
      if (!isOverlay && (lbl || sub || cta)) {
        belowHtml = '<div class="zw-mg-below">' + (lbl ? '<p class="zw-mg-h">' + lbl + '</p>' : '') + (sub ? '<p class="zw-mg-desc">' + sub + '</p>' : '') + (cta ? '<span class="zw-mg-link">' + cta + arrow + '</span>' : '') + '</div>';
      }
      var cardStyle = 'position:relative; display:block; text-decoration:none; color:inherit;';
      return '<' + tag + href + ' class="zw-mg-card" style="' + cardStyle + '"><div class="zw-mg-media-wrap" style="position:relative; overflow:hidden;">' + media + overlayHtml + watch + '</div>' + belowHtml + '</' + tag + '>';
    }).join('');
    el.innerHTML = '<div style="padding:0 ' + px + ';max-width:' + mw + ';margin:0 auto;">' + (s.heading ? '<h2 style="font-family:var(--fw);font-size:clamp(1.5rem,3vw,2.2rem);text-transform:uppercase;font-weight:800;font-style:italic;text-align:center;margin-bottom:2rem">' + s.heading + '</h2>' : '') + '<div class="' + trackClass + '" style="' + trackStyle + '">' + cardsHtml + '</div></div>';
    return true;
  }

  function renderCarousel(el, s) {
    el.className = 'builder-hero-carousel-section';
    var hMap = { full: '100vh', tall: '75vh', half: '50vh', short: '40vh' };
    el.style.cssText = 'position:relative; overflow:hidden; width:100%; height:' + (hMap[s.height] || '100vh') + '; background:' + (s.sec_bg || '#09090b') + ';';
    var slides = Array.isArray(s.slides) ? s.slides : [];
    if (!slides.length) { el.innerHTML = '<div style="padding:4rem;text-align:center;color:#fff">Add slides in the editor</div>'; return true; }
    var indStyle = s.indicator_style === 'lines' ? 'lines' : 'dots';
    var slidesHtml = '', dotsHtml = '';
    // Per-slide framing: base center focal_y% (desktop); the viewfinder adds
    // per-device object-position via CSS vars on tablet/mobile (see .zw-hc-media).
    var _hasXY = function (x, y) { return x != null && x !== '' && y != null && y !== ''; };
    var posVars = function (sl) {
      var v = '--zwh-pos:center ' + (sl.focal_y != null ? sl.focal_y : 50) + '%;';
      if (_hasXY(sl.focalTab_x, sl.focalTab_y)) v += '--zwh-pos-tab:' + sl.focalTab_x + '% ' + sl.focalTab_y + '%;';
      if (_hasXY(sl.focalMob_x, sl.focalMob_y)) v += '--zwh-pos-mob:' + sl.focalMob_x + '% ' + sl.focalMob_y + '%;';
      return v;
    };
    slides.forEach(function (sl, i) {
      var active = i === 0 ? ' active' : '';
      var media;
      if (sl.media_type === 'video' || isVideoUrl(sl.media_url)) {
        var auto = (i === 0 && s.autoplay !== false) ? ' autoplay' : '';
        var loopAttr = (sl.video_duration_mode || 'full') === 'full' ? '' : ' loop';
        // Preload so a non-first slide shows its first frame instead of black.
        var vidPreload = i === 0 ? 'auto' : 'metadata';
        media = '<video class="zw-hc-media" src="' + (sl.media_url || '') + '" poster="' + (sl.video_poster || '') + '" playsinline' + loopAttr + ' muted' + auto + ' preload="' + vidPreload + '" style="' + posVars(sl) + '"></video>';
      } else {
        // Never lazy-load carousel slides: an off-screen lazy slide (translateX
        // transition) never loads until navigated to, showing blank. Load all
        // eagerly — first high priority, the rest low — and fall back to the raw
        // URL if the Cloudinary-optimized one fails, so a slide is never blank.
        var loadAttr = i === 0 ? 'fetchpriority="high"' : 'loading="eager" fetchpriority="low"';
        media = '<picture class="zw-hc-media" style="' + posVars(sl) + '">' + (sl.media_url_mobile ? '<source media="(max-width:768px)" srcset="' + optImg(sl.media_url_mobile, 800) + '">' : '') + '<img src="' + optImg(sl.media_url, 1400) + '" alt="" ' + loadAttr + ' decoding="async" data-raw="' + (sl.media_url || '') + '" onerror="var i=this;if(!i.dataset.fb&&i.dataset.raw){i.dataset.fb=1;var p=i.parentNode;if(p){var ss=p.querySelectorAll(\'source\');for(var k=0;k<ss.length;k++)ss[k].removeAttribute(\'srcset\');}i.src=i.dataset.raw;}"></picture>';
      }
      slidesHtml += '<div class="zw-hc-slide' + active + '" data-index="' + i + '" data-duration="' + (sl.duration || '') + '" data-video-mode="' + (sl.video_duration_mode || 'full') + '">' + media +
        '<div class="zw-hc-overlay" style="opacity:' + ((sl.overlay_opacity != null ? sl.overlay_opacity : 30) / 100) + '"></div>' +
        '<div class="zw-hc-content" style="text-align:' + (sl.text_align || 'center') + '; color:' + (sl.text_color || '#ffffff') + '">' +
        (sl.eyebrow ? '<p class="zw-hc-eyebrow">' + sl.eyebrow + '</p>' : '') +
        (sl.heading ? '<h2 class="zw-hc-heading">' + String(sl.heading).replace(/\n/g, '<br>') + '</h2>' : '') +
        (sl.subtext ? '<p class="zw-hc-subtext">' + sl.subtext + '</p>' : '') +
        (sl.cta_text ? '<a class="zw-hc-cta btn-' + (sl.cta_style || 'solid') + '" href="' + safeUrl(sl.cta_url) + '">' + sl.cta_text + '</a>' : '') +
        '</div>' +
        (sl.watch_btn ? '<button class="zw-hc-watch" onclick="openWatchModal(\'' + (sl.watch_url || '') + '\')"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> ' + (sl.watch_label || 'Watch') + '</button>' : '') +
        '</div>';
      dotsHtml += '<button class="zw-hc-dot' + (indStyle === 'lines' ? ' zw-hc-line' : '') + active + '" data-index="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>';
    });
    el.innerHTML =
      '<div class="zw-hc-track zw-hc-trans-' + (s.transition || 'fade') + '">' + slidesHtml + '</div>' +
      '<div class="zw-hc-controls"><div></div>' +
      ((s.show_dots !== false && slides.length > 1) ? '<div class="zw-hc-dots' + (indStyle === 'lines' ? ' zw-hc-dots--lines' : '') + '">' + dotsHtml + '</div>' : '<div></div>') +
      '<div class="zw-hc-nav">' +
      ((s.show_pause !== false && slides.length > 1) ? '<div class="zw-hc-pause-wrap"><svg class="zw-hc-progress-svg"><circle cx="20" cy="20" r="18" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="2"/><circle class="zw-hc-progress-ring" cx="20" cy="20" r="18" fill="none" stroke="#111" stroke-width="2" stroke-dasharray="113" stroke-dashoffset="113"/></svg><button class="zw-hc-pause" aria-label="Pause/Play"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg></button></div>' : '') +
      ((s.show_arrows !== false && slides.length > 1) ? '<button class="zw-hc-prev" aria-label="Previous"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg></button><button class="zw-hc-next" aria-label="Next"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></button>' : '') +
      '</div></div>';
    initCarousel(el, s);
    return true;
  }

  // Carousel behaviour — mirrors storefront.js initCarousel.
  function initCarousel(el, s) {
    var autoplay = s.autoplay !== false;
    var interval = s.autoplay_interval || 5000;
    var loop = s.loop !== false;
    var track = el.querySelector('.zw-hc-track');
    var slideEls = Array.prototype.slice.call(el.querySelectorAll('.zw-hc-slide'));
    var dots = Array.prototype.slice.call(el.querySelectorAll('.zw-hc-dot'));
    var btnPrev = el.querySelector('.zw-hc-prev'), btnNext = el.querySelector('.zw-hc-next'), btnPause = el.querySelector('.zw-hc-pause');
    if (!track || !slideEls.length) return;
    // The 'slide' transition is a horizontal flex row — it only moves if we
    // translate the track. Without this the 2nd+ slides never scroll into view.
    var isSlideTrans = track.classList.contains('zw-hc-trans-slide');
    var curIdx = 0, isPaused = false, elapsed = 0, lastTick = Date.now(), rafId = null, visible = true;
    function applyTrack() { if (isSlideTrans) track.style.transform = 'translateX(-' + (curIdx * 100) + '%)'; }
    applyTrack();
    var progressRing = el.querySelector('.zw-hc-progress-ring'), circ = 113;
    function setProgress(pct) { if (progressRing) progressRing.style.strokeDashoffset = circ - (pct / 100) * circ; }
    function updatePauseIcon() { if (!btnPause) return; var svgEl = btnPause.querySelector('svg'); if (svgEl) svgEl.innerHTML = isPaused ? '<path d="M8 5v14l11-7z"/>' : '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'; }
    function update(newIdx) {
      if (!loop) { if (newIdx < 0) newIdx = 0; if (newIdx >= slideEls.length) newIdx = slideEls.length - 1; }
      else { if (newIdx < 0) newIdx = slideEls.length - 1; if (newIdx >= slideEls.length) newIdx = 0; }
      if (newIdx === curIdx) return;
      var oldVid = slideEls[curIdx].querySelector('video'); if (oldVid) { oldVid.pause(); oldVid.currentTime = 0; }
      slideEls[curIdx].classList.remove('active'); if (dots[curIdx]) dots[curIdx].classList.remove('active');
      curIdx = newIdx;
      slideEls[curIdx].classList.add('active'); if (dots[curIdx]) dots[curIdx].classList.add('active');
      applyTrack();
      var newVid = slideEls[curIdx].querySelector('video'); if (newVid && !isPaused) { newVid.currentTime = 0; newVid.play().catch(function () {}); }
      elapsed = 0; lastTick = Date.now(); setProgress(0);
    }
    function next() { update(curIdx + 1); }
    function prev() { update(curIdx - 1); }
    if (btnPrev) btnPrev.onclick = function () { isPaused = false; updatePauseIcon(); prev(); startLoop(); };
    if (btnNext) btnNext.onclick = function () { isPaused = false; updatePauseIcon(); next(); startLoop(); };
    dots.forEach(function (d) { d.onclick = function () { isPaused = false; updatePauseIcon(); update(parseInt(d.dataset.index)); startLoop(); }; });
    if (btnPause) btnPause.onclick = function () { isPaused = !isPaused; updatePauseIcon(); var vid = slideEls[curIdx].querySelector('video'); if (isPaused) { if (vid) vid.pause(); } else { lastTick = Date.now(); if (vid) vid.play().catch(function () {}); startLoop(); } };
    function stopLoop() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } }
    function tick() {
      if (isPaused || !autoplay || slideEls.length <= 1 || !visible) { rafId = null; return; }
      rafId = requestAnimationFrame(tick);
      var now = Date.now(), dt = now - lastTick; lastTick = now;
      var curSlide = slideEls[curIdx], vid = curSlide.querySelector('video');
      if (curSlide.dataset.videoMode === 'full' && vid) { if (vid.duration && !isNaN(vid.duration) && vid.duration > 0) setProgress(Math.min(100, Math.max(0, (vid.currentTime / vid.duration) * 100))); }
      else { elapsed += dt; var dur = parseInt(curSlide.dataset.duration) || interval; setProgress(Math.min(100, Math.max(0, (elapsed / dur) * 100))); if (elapsed >= dur) next(); }
    }
    function startLoop() { if (rafId == null && visible && !isPaused && autoplay && slideEls.length > 1) { lastTick = Date.now(); rafId = requestAnimationFrame(tick); } }
    startLoop();
    if ('IntersectionObserver' in window) { var obs = new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) startLoop(); else stopLoop(); }, { threshold: 0 }); obs.observe(el); }
    slideEls.forEach(function (sl, i) { if (sl.dataset.videoMode === 'full') { var v = sl.querySelector('video'); if (v) v.addEventListener('ended', function () { if (!isPaused && curIdx === i) next(); }); } });
    var tsx = 0, tex = 0;
    track.addEventListener('touchstart', function (e) { tsx = e.changedTouches[0].screenX; }, { passive: true });
    track.addEventListener('touchend', function (e) { tex = e.changedTouches[0].screenX; var diff = tsx - tex; if (Math.abs(diff) > 50) { isPaused = false; updatePauseIcon(); if (diff > 0) next(); else prev(); startLoop(); } }, { passive: true });
  }

  function startCountdown(el, s, secId) {
    var target = s.launch_date ? new Date(s.launch_date) : null;
    var cdEl = document.getElementById('lp-cd-' + secId);
    if (!target || !cdEl) return;
    var nums = cdEl.querySelectorAll('.cd-n');
    function pad(n) { return String(n).padStart(2, '0'); }
    function t() {
      var diff = target - Date.now();
      if (diff <= 0) { nums.forEach(function (n) { n.textContent = '00'; }); return; }
      if (nums[0]) nums[0].textContent = pad(Math.floor(diff / 864e5));
      if (nums[1]) nums[1].textContent = pad(Math.floor((diff % 864e5) / 36e5));
      if (nums[2]) nums[2].textContent = pad(Math.floor((diff % 36e5) / 6e4));
      if (nums[3]) nums[3].textContent = pad(Math.floor((diff % 6e4) / 1e3));
    }
    t(); setInterval(t, 1000);
  }

  function ensureMarqueeKeyframes() {
    if (document.getElementById('zw-lp-marquee-kf')) return;
    var st = document.createElement('style'); st.id = 'zw-lp-marquee-kf';
    st.textContent = '@keyframes zwLpMarquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}';
    document.head.appendChild(st);
  }

  window.ZWLandingSections = {
    // Apply heading/body font overrides to any element (used by landing.js for
    // the auto hero). Empty key clears the override so the global theme returns.
    applyFonts: function (el, headKey, bodyKey) {
      if (!el) return;
      if (headKey && FONT_STACKS[headKey]) { el.style.setProperty('--fw', FONT_STACKS[headKey]); el.style.setProperty('--zw-font-head', FONT_STACKS[headKey]); loadFont(headKey); }
      else { el.style.removeProperty('--fw'); el.style.removeProperty('--zw-font-head'); }
      if (bodyKey && FONT_STACKS[bodyKey]) { el.style.setProperty('--fb', FONT_STACKS[bodyKey]); el.style.setProperty('--zw-font-body', FONT_STACKS[bodyKey]); loadFont(bodyKey); }
      else { el.style.removeProperty('--fb'); el.style.removeProperty('--zw-font-body'); }
    },
    render: function (host, sections) {
      if (!host) return;
      host.innerHTML = '';
      var list = (Array.isArray(sections) ? sections : []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      // Live landing pages honor a section's scheduled visibility window; the
      // builder preview (?preview=1) ignores it so scheduled sections stay editable.
      var _isPreview = /[?&]preview=1/.test(location.search);
      var inWindow = function (s) {
        if (!s) return true;
        try {
          var now = Date.now();
          if (s.visible_from) { var a = new Date(s.visible_from).getTime(); if (!isNaN(a) && now < a) return false; }
          if (s.visible_until) { var b = new Date(s.visible_until).getTime(); if (!isNaN(b) && now > b) return false; }
        } catch (_) {}
        return true;
      };
      list.forEach(function (sec) {
        if (!sec || sec.visible === false) return;
        var s = sec.settings || {};
        if (!_isPreview && !inWindow(s)) return;
        var el = document.createElement('section');
        el.id = sec.id;
        var ok = renderBody(el, sec, s);
        if (ok === false) return;
        applyTail(el, s, sec.id);
        host.appendChild(el);
        // Per-device grid/swipe layout for any section with a .zw-plat-grid.
        var _plg = el.querySelector('.zw-plat-grid');
        if (_plg && window.zwApplyPlatLayout) window.zwApplyPlatLayout(_plg, s);
        if (sec.type === 'countdown') startCountdown(el, s, sec.id);
      });
    }
  };
})();
