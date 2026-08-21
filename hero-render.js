/**
 * hero-render.js — the homepage hero, lifted out of storefront.js.
 *
 * WHY IT LEFT. The hero is the first thing anybody sees and it was rendered by
 * a `case` inside a 280 KB file that runs 30th in the deferred chain. Its IMAGE
 * was rescued earlier: the <head> reads the last one out of localStorage and
 * preloads it at high priority, so the photograph is already on its way before
 * a single module has parsed. Its WORDS were not. The headline, the kicker, the
 * subtext, both buttons and the image overlay all waited for storefront.js to
 * finish parsing, which means a visitor read the SHIPPED default copy first and
 * watched it change.
 *
 * So this file does two things, and the second is the point:
 *
 *   1. It owns paint(), which is the exact renderer storefront.js used to hold.
 *      storefront.js calls it now — one implementation, called from two places,
 *      rather than a copy that can drift from the builder's idea of a hero.
 *
 *   2. It paints ONCE ON ITS OWN, the moment the settings response lands,
 *      without waiting for the rest of the chain. It sits third in the page,
 *      right behind zw-data.js, so it is parsed and ready long before
 *      storefront.js is even fetched.
 *
 * ── WHY IT PAINTS TWICE, AND WHY THAT IS FINE ────────────────────────────────
 *
 * storefront.js still calls paint() on its own pass, and the builder preview
 * calls it again on every edit. paint() is a pure write of `s` onto `el` — the
 * same input produces the same DOM — so the second pass writes what is already
 * there. Making the early pass suppress the later one would mean the builder's
 * live preview stopped updating, which is a much worse trade than a redundant
 * assignment nobody can see.
 *
 * ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────
 *
 * The early pass is skipped entirely in the builder preview and behind
 * ?builder=1 or ?zwpreview=. Those paths render the DRAFT, and painting the
 * PUBLISHED hero first would show an editor their old copy for a moment on
 * every single edit — the exact flash this file exists to remove, aimed at the
 * one person guaranteed to notice.
 */
(function () {
  'use strict';

  /* storefront.js keeps its own zwSafeUrl inside its module scope, so this is
     the same rule rather than a reach into a file that may not have run yet.
     Anything that is not a fragment, a rooted path, an http(s) URL, a mailto or
     a tel becomes '#' — a javascript: URL in a builder field is the thing this
     stops. */
  function safeUrl(value) {
    if (typeof window.zwSafeUrl === 'function') return window.zwSafeUrl(value);
    var u = String(value == null ? '' : value).trim();
    if (!u) return '#';
    if (/^(?:#|\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(u)) return u;
    return '#';
  }

  /* A SEPARATE, LOOSER RULE FOR href, AND THAT IS DELIBERATE.
     safeUrl above is an allowlist, which is right for location.href — the two
     button handlers assign to it and have always run their value through it.
     Applying the same allowlist to the image overlay's href would be a
     REGRESSION: it rejects a bare relative path, and 'drop001.html' without a
     leading slash is a perfectly ordinary thing to have typed into that field.
     A store with one would have found its overlay button silently pointing at
     '#'.

     The overlay's href was previously not filtered at all, so this refuses only
     the schemes that can execute and leaves every real link alone. Control
     characters are stripped first, because `java\tscript:` is still parsed as a
     scheme by the browser but not by a naive prefix test. */
  function safeHref(value) {
    var u = String(value == null ? '' : value).trim();
    if (!u) return '#';
    var bare = u.replace(/[\x00-\x1f]/g, '');
    if (/^\s*(?:javascript|data|vbscript):/i.test(bare)) return '#';
    return u;
  }

  /* image-utils.js is the real optimiser but it loads later in the chain than
     this does, so on the early pass it is usually absent. The <head> exposes
     its own copy for exactly this reason — same Cloudinary account, same width
     caps — and the raw URL is the last resort rather than the first. */
  function opt(url, width) {
    if (typeof window.optimizeImage === 'function') return window.optimizeImage(url, width);
    if (typeof window.zwOptHead === 'function') return window.zwOptHead(url, width);
    return url;
  }

  /**
   * Write one hero section's configuration onto one hero element.
   * @param {Element} el the <section class="hero">
   * @param {Object} s   the section config from the page builder
   */
  function paint(el, s) {
    if (!el || !s) return;

    var h1 = el.querySelector('.hero-h1');
    var sub = el.querySelector('.hero-sub');
    var kicker = el.querySelector('.hero-kicker');
    var ctaPrimary = el.querySelector('.hero-cta-row .btn-outline');
    var ctaSecondary = el.querySelector('.hero-cta-row .btn-ghost');
    if (h1 && s.heading !== undefined) h1.innerHTML = String(s.heading || '').replace(/\n/g, '<br>');
    if (sub && s.subtext !== undefined) sub.textContent = s.subtext || '';
    if (kicker && s.kicker !== undefined) kicker.textContent = s.kicker || '';

    var primaryText = s.cta1_text || s.cta_primary_text;
    var primaryUrl = s.cta1_url || s.cta_primary_url;
    if (ctaPrimary && primaryText !== undefined) {
      /* The arrow is a child SVG, and textContent would delete it. Put it back
         rather than rebuilding the button, so nothing else about it changes. */
      var svg = ctaPrimary.querySelector('svg');
      ctaPrimary.textContent = primaryText;
      if (svg) ctaPrimary.appendChild(svg);
    }
    if (ctaPrimary && primaryUrl) {
      ctaPrimary.onclick = function () {
        if (String(primaryUrl).charAt(0) === '#') {
          var t = document.getElementById(String(primaryUrl).slice(1));
          if (t) t.scrollIntoView({ behavior: 'smooth' });
        } else location.href = safeUrl(primaryUrl);
      };
    }

    var secondaryVisible = s.cta2_on !== undefined ? s.cta2_on : s.cta_secondary_visible;
    var secondaryText = s.cta2_text || s.cta_secondary_text;
    var secondaryUrl = s.cta2_url || s.cta_secondary_url;
    if (ctaSecondary) ctaSecondary.style.display = secondaryVisible ? '' : 'none';
    if (ctaSecondary && secondaryText !== undefined) ctaSecondary.textContent = secondaryText;
    if (ctaSecondary && secondaryUrl) {
      ctaSecondary.onclick = function () {
        if (String(secondaryUrl).charAt(0) === '#') {
          var t = document.getElementById(String(secondaryUrl).slice(1));
          if (t) t.scrollIntoView({ behavior: 'smooth' });
        } else location.href = safeUrl(secondaryUrl);
      };
    }

    /* The overlay button on the photograph itself. Created on demand, because
       most heroes do not have one and an empty anchor over the image would sit
       in the accessibility tree for no reason. */
    var imgCta = el.querySelector('.hero-img-cta');
    var imgCtaVisible = s.img_btn_on !== undefined ? s.img_btn_on : s.image_cta_visible;
    var imgCtaText = s.img_btn_text || s.image_cta_text;
    var imgCtaUrl = s.img_btn_url || s.image_cta_url;
    if (imgCtaVisible) {
      if (!imgCta) {
        imgCta = document.createElement('a');
        imgCta.className = 'hero-img-cta';
        imgCta.style.cssText = 'position:absolute;bottom:30%;left:50%;transform:translateX(-50%);z-index:10;padding:.65rem 1.8rem;background:rgba(255,255,255,.92);color:#09090b;font-family:var(--fm);font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;text-decoration:none;backdrop-filter:blur(8px);transition:opacity .2s';
        var wrap = el.querySelector('.hero-img-wrap');
        if (wrap) wrap.appendChild(imgCta);
      }
      imgCta.textContent = imgCtaText || 'Shop Now';
      imgCta.href = safeHref(imgCtaUrl || '/drop001.html');
      imgCta.style.display = '';
    } else if (imgCta) imgCta.style.display = 'none';

    var img = el.querySelector('#hero-image');
    var mobileSource = el.querySelector('#hero-mobile-source');
    if (s.image) {
      var optDesk = opt(s.image, 1400);
      var optMob = opt(s.image, 800);
      if (img) img.src = optDesk;
      if (mobileSource) mobileSource.srcset = optMob;
      /* Cache it so the synchronous <head> bootstrap paints THIS image on the
         next load rather than the shipped default. The page-builder hero path
         did not used to update this cache, so every load flashed old -> new.
         Never from the builder preview: an unpublished hero must not become
         what the real homepage shows first. */
      if (!window.__ZW_BUILDER_PREVIEW__) {
        window.__ZW_HERO_IMAGE = optDesk;
        try { localStorage.setItem('zw-hero-image', s.image); } catch (e) {}
        var preload = document.getElementById('hero-preload');
        if (preload) preload.href = optDesk;
      }
    } else {
      if (img) img.src = 'images/hero.jpg?v=2';
      if (mobileSource) mobileSource.srcset = 'images/hero-mobile.jpg';
    }

    /* Fill (cover) against Fit (contain) — contain lets a logo or a graphic
       show whole instead of being cropped to the bleed. */
    if (img) img.style.objectFit = (s.fit === 'contain') ? 'contain' : 'cover';

    /* Viewfinder framing. A focal point chosen in the builder becomes
       object-position at the tablet and mobile breakpoints, through the two
       custom properties .hero-img-wrap img reads. Unset clears the property so
       the CSS fallback (centre) applies rather than a stale value sticking. */
    if (img) {
      var pos = function (f) { return (f && f.x != null && f.y != null) ? (f.x + '% ' + f.y + '%') : ''; };
      var pt = pos(s.focalTab), pm = pos(s.focalMob);
      if (pt) img.style.setProperty('--zwh-pos-tab', pt); else img.style.removeProperty('--zwh-pos-tab');
      if (pm) img.style.setProperty('--zwh-pos-mob', pm); else img.style.removeProperty('--zwh-pos-mob');
    }
  }

  /* ── The early pass ────────────────────────────────────────────────────────
     Everything above is what storefront.js already did. This is the part that
     makes leaving storefront.js worth anything: ask the settings broker for the
     published layout and paint the hero the moment it answers, rather than
     after the remaining modules in the chain have parsed and run. */
  function previewing() {
    if (window.__ZW_BUILDER_PREVIEW__) return true;
    try {
      var q = new URLSearchParams(location.search);
      return q.get('builder') === '1' || !!q.get('zwpreview');
    } catch (_) { return false; }
  }

  function parseConfig(raw) {
    if (!raw) return null;
    try {
      var v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return (v && Array.isArray(v.sections)) ? v : null;
    } catch (_) { return null; }
  }

  function early() {
    if (previewing()) return;
    var el = document.querySelector('.hero');
    if (!el || !window.zwSettings || typeof window.zwSettings.get !== 'function') return;
    window.zwSettings.get('page_builder_published').then(function (raw) {
      var cfg = parseConfig(raw);
      if (!cfg) return;
      /* The FIRST visible hero, matching the order storefront.js applies. A
         layout with no hero section leaves the shipped markup alone — hiding it
         is zw-hide-static-hero's job, not this file's. */
      var sorted = cfg.sections.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      for (var i = 0; i < sorted.length; i++) {
        var s = sorted[i];
        if (s && s.type === 'hero' && s.visible !== false) { paint(el, s); return; }
      }
    }).catch(function () { /* storefront.js will try again on its own pass */ });
  }

  window.zwHero = { paint: paint, early: early };

  /* Deferred scripts run after parsing, so the hero element exists by now — but
     this file is also loaded by the builder preview harness, where it can be
     injected at any point. The readyState guard covers both. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', early, { once: true });
  } else {
    early();
  }
}());
