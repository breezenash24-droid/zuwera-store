/**
 * Put the CURRENT header arrangement into the HTML as it is served.
 *
 * ── THE ONE CASE THE OTHER TWO ANSWERS CANNOT REACH ─────────────────────────
 *
 * The arrangement already reaches a page three ways, and each has a window
 * where it is wrong:
 *
 *   baked at build time   right until the next publish. A publish does not
 *                         rebuild the site, so from that moment the deployed
 *                         HTML names the previous arrangement.
 *   cached in the browser right from this visitor's SECOND load after a
 *                         change. Their first one still corrects itself in
 *                         front of them, and a first-ever visitor has nothing.
 *   fetched at runtime    always right, always after the first frame.
 *
 * So between a publish and the next deploy there is a real window where a
 * visitor sees the old header and watches it change. Closing it by deploying on
 * every publish would make every small edit cost a build, which is not a trade
 * worth making. Closing it here costs nothing per publish: the document simply
 * carries the answer it should have carried all along.
 *
 * ── WHY THIS IS SAFE TO PUT IN FRONT OF EVERY PAGE ──────────────────────────
 *
 * HTMLRewriter streams — the response is not buffered, so this adds no
 * meaningful latency and cannot truncate a page. The settings read starts
 * BEFORE the page is fetched, so the two happen together rather than in
 * sequence, and it is cached at the edge, so it is one origin request every
 * fifteen seconds per location rather than one per visitor.
 *
 * AND IT CAN ONLY EVER FALL BACK. Every failure path — no settings, a bad
 * response, a row with nothing resolved in it, an exception anywhere — returns
 * the untouched page, which still carries the baked answer and still corrects
 * itself from the cache and the fetch. This can make the first frame right; it
 * cannot make the page wrong.
 *
 * ── IT RESOLVES NOTHING ─────────────────────────────────────────────────────
 *
 * A layout name means nothing here: the table that turns "logo-center" into
 * four placement values lives in header-layouts.js, which is browser code and
 * cannot be imported into a Worker. Rather than keep a second copy of that
 * table at the edge — the duplication this feature has already been bitten by
 * once — the builder writes the RESOLVED values into the row when it publishes,
 * and this reads them. A row with no resolved values in it is skipped, so a
 * store that has not published since this shipped is simply left as it was.
 */
import { supabaseUrl, supabaseAnonKey } from './api/_config.js';

/* Long enough that a busy page costs one origin read rather than hundreds;
   short enough that a publish is visible almost immediately. The runtime fetch
   in header-layouts.js is uncached and still corrects anything this misses. */
const TTL = 15;

const SPOTS = { left: 1, center: 1, right: 1 };

/** The attributes to write, or null if there is nothing trustworthy to write.
 *
 *  Validated against the same vocabulary theme-engine.js accepts, for the same
 *  reason: an attribute the stylesheet has no rule for still reads as "placed"
 *  and suppresses the arrangement the page ships with, so a junk value would
 *  produce a header with no placement rather than no change. */
export function attrsFrom(value, updatedAt) {
  if (!value || typeof value !== 'object') return null;
  const out = {};

  const s = value.spec;
  if (s && typeof s === 'object'
      && SPOTS[s.logo] && (SPOTS[s.links] || s.links === 'none') && SPOTS[s.actions]) {
    out['data-zw-hdr'] = '1';
    out['data-zw-hdr-logo'] = s.logo;
    out['data-zw-hdr-links'] = s.links;
    out['data-zw-hdr-actions'] = s.actions;
    out['data-zw-hdr-linksrow'] = String(s.linksRow) === '2' ? '2' : '1';

    /* ── WITHOUT THIS LINE THE STAMP GETS UNDONE ────────────────────────────
       data-zw-hdr-at does not describe when the page was built. It means "the
       attributes on this element are as of this moment", and the pre-paint
       block uses it to decide whether the visitor's cached arrangement is
       newer than the one already on the page.

       Stamping the placement here and leaving the timestamp as the BUILD left
       it said, in effect, "this is the answer from the last deploy". Every
       returning visitor whose cache post-dates that deploy therefore read
       their own older copy as the fresher one and overwrote a correct stamp
       with a stale arrangement — visibly, on load, and then the runtime fetch
       repaired it and rewrote the cache, so it healed and came back. That is
       the "sometimes, if you refresh enough" flash.

       Written only alongside the placement, never on its own: the timestamp
       has to describe the attributes that are actually there, and if the
       placement could not be resolved then the ones on the element came from
       the build and are genuinely that old. */
    if (updatedAt) out['data-zw-hdr-at'] = String(updatedAt);
  }
  /* Independent of the placement, exactly as it is everywhere else: a store can
     turn the rule off, move the account control, or ask for words instead of
     glyphs without ever choosing an arrangement. */
  if (value.lines === 'on' || value.lines === 'off') out['data-zw-hdr-lines'] = value.lines;
  /* Also on <html>, and NOT a duplicate of the <body> stamp below: the
     stylesheet reads it from either, the head pre-paint can only ever write
     this one, and a document that carries it in both places is a document
     whose two writers cannot disagree with each other. */
  if (value.account === 'header' || value.account === 'bag') out['data-zw-account'] = value.account;
  if (value.iconLabels === 'mobile' || value.iconLabels === 'always') {
    out['data-zw-iconlabels'] = value.iconLabels;
  } else if (value.iconLabels === 'icons') {
    /* An explicit "glyphs, please" has to be able to REMOVE what the build
       baked from a theme that asked for words. null is the instruction to
       remove; absent means the row said nothing and the bake stands. */
    out['data-zw-iconlabels'] = null;
  }

  return Object.keys(out).length ? out : null;
}

/** The same, for <body>. data-zw-account's natural home is there — the rule it
 *  qualifies is written against body.zwf-bagpanel-on — and the build bakes it
 *  there. It is ALSO accepted on <html>, because the pre-paint block in <head>
 *  has no <body> to write to and that block is the only writer early enough to
 *  beat the header's first paint. Written on both here so the served document
 *  and the cached answer agree about which element carries it.
 *
 *  Separate function because it is a separate HTMLRewriter selector, and
 *  returning it mixed in with the <html> attributes is how it would end up on
 *  the wrong element. */
export function bodyAttrsFrom(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.account === 'header') return { 'data-zw-account': 'header' };
  if (value.account === 'bag') return { 'data-zw-account': null };
  return null;
}

async function headerAttrs(env) {
  const base = supabaseUrl(env);
  const key = supabaseAnonKey(env);
  if (!base || !key) return null;
  const res = await fetch(
    base + '/rest/v1/site_settings?select=value,updated_at&key=eq.header_layout',
    {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      cf: { cacheTtl: TTL, cacheEverything: true },
    },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  const row = rows && rows[0];
  let v = row && row.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
  return { html: attrsFrom(v, row && row.updated_at), body: bodyAttrsFrom(v) };
}

class Stamp {
  constructor(attrs) { this.attrs = attrs; }
  element(el) {
    /* setAttribute REPLACES, so the build's baked values are overwritten rather
       than joined by a second copy. Anything this does not name — the theme
       stamp, lang — is left exactly as it was.

       A null value is the instruction to REMOVE, which is not the same as not
       naming the attribute at all: "glyphs, not words" has to be able to undo a
       bake that says otherwise, and leaving the bake alone would make the
       choice invisible until the runtime fetch landed. */
    for (const k of Object.keys(this.attrs)) {
      const v = this.attrs[k];
      if (v === null) el.removeAttribute(k); else el.setAttribute(k, v);
    }
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  let url;
  try { url = new URL(request.url); } catch (_) { return context.next(); }

  /* Not worth a settings read: API routes are not pages, a non-GET is not a
     page load, and a builder preview must show the DRAFT — stamping the
     published arrangement there is the one thing that would actively mislead. */
  const skip = request.method !== 'GET'
    || url.pathname.startsWith('/api/')
    || /[?&]builder=1(?:&|$)/.test(url.search);

  /* Started before the page is fetched so the two overlap. A rejection here
     must not take the page down with it. */
  const pending = skip ? null : headerAttrs(env).catch(() => null);

  const res = await context.next();
  if (skip) return res;

  try {
    const ct = (res.headers && res.headers.get('content-type')) || '';
    if (!ct.includes('text/html')) return res;
    const attrs = await pending;
    if (!attrs || (!attrs.html && !attrs.body)) return res;
    let rw = new HTMLRewriter();
    if (attrs.html) rw = rw.on('html', new Stamp(attrs.html));
    if (attrs.body) rw = rw.on('body', new Stamp(attrs.body));
    return rw.transform(res);
  } catch (_) {
    return res;   // the page as it was, which is still a working page
  }
}
