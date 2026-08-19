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
export function attrsFrom(value) {
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
  }
  /* Independent of the placement, exactly as it is everywhere else: a store can
     turn the rule off without ever choosing an arrangement. */
  if (value.lines === 'on' || value.lines === 'off') out['data-zw-hdr-lines'] = value.lines;

  return Object.keys(out).length ? out : null;
}

async function headerAttrs(env) {
  const base = supabaseUrl(env);
  const key = supabaseAnonKey(env);
  if (!base || !key) return null;
  const res = await fetch(
    base + '/rest/v1/site_settings?select=value&key=eq.header_layout',
    {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      cf: { cacheTtl: TTL, cacheEverything: true },
    },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  let v = rows && rows[0] && rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
  return attrsFrom(v);
}

class Stamp {
  constructor(attrs) { this.attrs = attrs; }
  element(el) {
    /* setAttribute REPLACES, so the build's baked values are overwritten rather
       than joined by a second copy. Anything this does not name — the theme
       stamp, lang — is left exactly as it was. */
    for (const k of Object.keys(this.attrs)) el.setAttribute(k, this.attrs[k]);
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
    if (!attrs) return res;
    return new HTMLRewriter().on('html', new Stamp(attrs)).transform(res);
  } catch (_) {
    return res;   // the page as it was, which is still a working page
  }
}
