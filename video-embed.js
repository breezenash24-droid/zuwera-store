/* ────────────────────────────────────────────────────────────────────────────
   video-embed.js — one place that knows how to turn a pasted video URL into an
   embed, shared by every renderer.

   Exposes window.ZWVideoEmbed:
     detect(url)  -> { platform, id, aspect } | null
     html(s)      -> the finished markup for a builder `video` section

   Why shared: the homepage renderer (storefront.js) and the landing renderer
   (landing-sections.js) each had their own copy of the YouTube/Vimeo regexes,
   already drifting apart. Adding TikTok, Reels and Shorts to two copies would
   have guaranteed they diverge, so both now call this.

   Supported: YouTube (watch / youtu.be / Shorts / embed), TikTok, Instagram
   (post + reel), Vimeo, and a direct video file (mp4/webm/mov/m4v/ogv).

   Aspect: each platform has a natural default — Shorts, TikTok and Reels are
   vertical (9:16), everything else 16:9 — and the section can override it.
   That default matters: the old renderer hardcoded 56.25% padding-bottom, so a
   vertical video would have been letterboxed into a wide box with bars.

   CSP: every host framed here is in _headers' frame-src. A new platform needs
   adding there too, or enforcing that policy later will blank the embed.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var ASPECTS = {
    '16x9': '56.25%',
    '9x16': '177.78%',
    '1x1':  '100%',
    '4x5':  '125%',
    '4x3':  '75%'
  };

  function detect(raw) {
    var url = String(raw || '').trim();
    if (!url) return null;
    var m;

    // YouTube Shorts — vertical, and the id sits in a different path segment.
    if ((m = url.match(/youtube\.com\/shorts\/([\w-]+)/)))
      return { platform: 'youtube', id: m[1], aspect: '9x16' };

    // YouTube watch / short link / already-an-embed.
    if ((m = url.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/)))
      return { platform: 'youtube', id: m[1], aspect: '16x9' };

    // TikTok — /@user/video/<id>, or a bare numeric id from a share sheet.
    if ((m = url.match(/tiktok\.com\/(?:@[\w.-]+\/video\/|v\/|embed\/v2\/)(\d+)/)))
      return { platform: 'tiktok', id: m[1], aspect: '9x16' };

    // Instagram reel (vertical) vs feed post (square by convention).
    if ((m = url.match(/instagram\.com\/reels?\/([\w-]+)/)))
      return { platform: 'instagram', id: m[1], aspect: '9x16', path: 'reel' };
    if ((m = url.match(/instagram\.com\/p\/([\w-]+)/)))
      return { platform: 'instagram', id: m[1], aspect: '1x1', path: 'p' };

    if ((m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/)))
      return { platform: 'vimeo', id: m[1], aspect: '16x9' };

    // Self-hosted / direct file. Query strings are common on signed URLs, so
    // test the path only.
    if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(url))
      return { platform: 'file', id: url, aspect: '16x9' };

    return null;
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Embed URL for an iframe platform, honouring the section's playback flags. */
  function src(info, s) {
    var p;
    switch (info.platform) {
      case 'youtube':
        p = new URLSearchParams({ rel: '0', playsinline: '1' });
        if (s.autoplay) { p.set('autoplay', '1'); p.set('mute', '1'); } // browsers block unmuted autoplay
        else if (s.muted) p.set('mute', '1');
        if (s.controls === false) p.set('controls', '0');
        if (s.loop) { p.set('loop', '1'); p.set('playlist', info.id); } // loop needs playlist=self
        return 'https://www.youtube-nocookie.com/embed/' + info.id + '?' + p;

      case 'vimeo':
        p = new URLSearchParams();
        if (s.autoplay) { p.set('autoplay', '1'); p.set('muted', '1'); }
        else if (s.muted) p.set('muted', '1');
        if (s.controls === false) p.set('controls', '0');
        if (s.loop) p.set('loop', '1');
        return 'https://player.vimeo.com/video/' + info.id + (p.toString() ? '?' + p : '');

      // TikTok and Instagram expose no playback flags on their embed URLs —
      // their players own autoplay/controls. Flags are ignored rather than
      // faked, so the editor hint says so.
      case 'tiktok':
        return 'https://www.tiktok.com/embed/v2/' + info.id;
      case 'instagram':
        return 'https://www.instagram.com/' + (info.path || 'p') + '/' + info.id + '/embed';
    }
    return '';
  }

  /**
   * @param {object} s builder section settings
   * @param {string} [placeholder] markup to show when there is no usable URL
   */
  function html(s, placeholder) {
    s = s || {};
    var info = detect(s.url);
    if (!info) {
      return placeholder != null ? placeholder :
        '<div style="background:rgba(244,241,235,.05);border:1px dashed rgba(244,241,235,.15);padding:4rem;text-align:center;opacity:.4;font-size:.8rem">' +
        'Paste a YouTube, TikTok, Instagram, Vimeo or .mp4 URL in the editor</div>';
    }

    // 'auto' (or unset) follows the platform's natural shape.
    var key = (s.aspect && s.aspect !== 'auto') ? s.aspect : info.aspect;
    var pb  = ASPECTS[key] || ASPECTS['16x9'];

    var inner;
    if (info.platform === 'file') {
      inner = '<video src="' + esc(info.id) + '"' +
        (s.controls === false ? '' : ' controls') +
        (s.autoplay ? ' autoplay muted' : (s.muted ? ' muted' : '')) +
        (s.loop ? ' loop' : '') +
        ' playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000"></video>';
    } else {
      inner = '<iframe src="' + esc(src(info, s)) + '" loading="lazy" title="Embedded video"' +
        ' style="position:absolute;inset:0;width:100%;height:100%;border:none"' +
        ' allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>';
    }

    // Vertical embeds get a sane max width so a 9:16 clip doesn't become a
    // full-viewport-tall column on desktop.
    var vertical = (key === '9x16' || key === '4x5');
    var wrapStyle = 'position:relative;padding-bottom:' + pb + ';height:0;overflow:hidden;' +
      (vertical ? 'max-width:420px;margin:0 auto;' : '');

    return '<div style="' + wrapStyle + '">' + inner + '</div>' +
      (s.caption ? '<p style="text-align:center;opacity:.45;font-size:.8rem;margin-top:1rem">' + esc(s.caption) + '</p>' : '');
  }

  window.ZWVideoEmbed = { detect: detect, html: html, ASPECTS: ASPECTS };
})();
