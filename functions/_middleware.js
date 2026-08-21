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
import { buildSitemap } from './api/_sitemap.js';

/* ── THIS NUMBER WAS COSTING EVERY VISITOR TTFB ─────────────────────────────
   It was 15 seconds, on the reasoning that a publish should be visible almost
   immediately. Measured against the deployed site, five runs each:

       /about.html   bypasses Functions      0.63 – 0.69s   tight
       /about        through this middleware 0.82 – 1.32s
       /             through this middleware 0.84 – 1.56s

   Two hundred to seven hundred milliseconds, on the front of every page, and
   variable — which is the signature of a cache miss. At a 15-second TTL almost
   every visitor to a quiet shop is the one who pays for the refill.

   Five minutes instead. The publish-visibility argument was always weaker than
   it looked: this is a FIRST-FRAME optimisation, and a publish already reaches
   the page three other ways within the same second (the cached answer, the
   runtime fetch, and the next deploy's bake). Nobody was ever waiting on this
   for correctness — only for the first frame to be right, which it still is
   for everyone whose visit lands inside the window. */
const TTL = 300;

/* And it is no longer waited for indefinitely. See the note at onRequest. */
const STAMP_BUDGET_MS = 60;

const SPOTS = { left: 1, center: 1, right: 1 };
const GAPS = { tight: 1, snug: 1, normal: 1, roomy: 1, wide: 1 };

/* ── The mirror, a second time ────────────────────────────────────────────────
   Left and right swap; centre is its own mirror; `none` is not a side at all
   (the categories are in the menu drawer) so it stays. linksRow is a row count,
   not a side.

   This duplicates mirror() in header-layouts.js, for the same reason SPOTS
   above duplicates theme-engine.js's vocabulary: a Worker cannot import a
   browser file, and the arrangement has to be in the HTML before any browser
   file runs. tests/header-layout-is-position-only.test.js holds the two
   definitions to the same answer on every shipped layout. */
const MIRROR = { left: 'right', right: 'left', center: 'center', none: 'none' };
function mirrorSpec(s) {
  return {
    ...s,
    logo: MIRROR[s.logo] || s.logo,
    links: MIRROR[s.links] || s.links,
    actions: MIRROR[s.actions] || s.actions,
  };
}

/** The attributes to write, or null if there is nothing trustworthy to write.
 *
 *  Validated against the same vocabulary theme-engine.js accepts, for the same
 *  reason: an attribute the stylesheet has no rule for still reads as "placed"
 *  and suppresses the arrangement the page ships with, so a junk value would
 *  produce a header with no placement rather than no change. */
export function attrsFrom(value, updatedAt) {
  if (!value || typeof value !== 'object') return null;
  const out = {};

  const raw = value.spec;
  /* Mirrored HERE rather than stored mirrored, so the settings row keeps saying
     which named arrangement was chosen and `flip` stays a modifier of it. A row
     that stored the already-flipped spec would read as a layout nobody can find
     in the gallery. */
  const s = (raw && typeof raw === 'object' && value.flip === 'on') ? mirrorSpec(raw) : raw;
  if (s && typeof s === 'object'
      && SPOTS[s.logo] && (SPOTS[s.links] || s.links === 'none') && SPOTS[s.actions]) {
    out['data-zw-hdr'] = '1';
    out['data-zw-hdr-logo'] = s.logo;
    out['data-zw-hdr-links'] = s.links;
    out['data-zw-hdr-actions'] = s.actions;
    out['data-zw-hdr-linksrow'] = String(s.linksRow) === '2' ? '2' : '1';
    /* The fifth placement attribute. Two rules in storefront-cohesion.css need
       to know an arrangement is MIRRORED rather than merely inferring it from
       the other four, because a centred pair reads the same either way round.
       See the note beside setHeader() in theme-engine.js. */
    if (value.flip === 'on') out['data-zw-hdr-flip'] = 'on';
    /* Category spacing, validated against the same five names the stylesheet
       has rules for. Anything else writes nothing and the shipped 2.4rem
       stands. */
    if (GAPS[value.navGap]) out['data-zw-hdr-gap'] = value.navGap;

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
  /* The sequence the action controls sit in. Validated here as well as at the
     writer, because a value the stylesheet has no rule for still counts as
     "ordered" and takes the default order away from every control at once. */
  if (typeof value.order === 'string'
      && /^(search|account|bag|orders|saves|support)( (search|account|bag|orders|saves|support))*$/.test(value.order.trim())) {
    out['data-zw-hdr-order'] = value.order.trim();
  }
  /* The devices that show words, as the stylesheet matches them. 'none' names
     no device and is how an explicit "glyphs everywhere" overrules a value the
     build baked — a removal would depend on the bake being the only other
     writer, which it is not. Validated as a list so a junk value cannot land
     on the element and be read as a scope nobody wrote. */
  if (typeof value.iconLabels === 'string'
      && /^(none|(phone|tablet|desktop)( (phone|tablet|desktop))*)$/.test(value.iconLabels.trim())) {
    out['data-zw-iconlabels'] = value.iconLabels.trim();
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

/* ── THE SETTINGS THE FIRST FRAME IS MADE OF ─────────────────────────────────
 *
 * Not all of them. `page_builder_published` alone is 12,180 bytes on the live
 * store and `legal_policies` another 6,623, and neither decides what the top of
 * the page LOOKS like before you scroll. These fourteen do: they carry the
 * colours, the fonts, the copy, the icons, the categories, the announcement bar
 * and the header arrangement.
 *
 * Measured against the live settings: 3,986 bytes, 1,552 gzipped. That is what
 * it costs to stop guessing.
 */
const FIRST_PAINT_KEYS = [
  'theme', 'theme_modes', 'text_overrides', 'fonts', 'icons', 'bag_panel',
  'header_layout', 'brand', 'nav_menu', 'product_card_cta', 'image_effects',
  'hero', 'header_behavior', 'announcement_bar',
];

/* The static sections index.html ships in its markup. A builder layout that
   omits one has to hide it, and until now that was remembered rather than
   known — see layoutClasses below. */
const DEFAULT_SECTIONS = ['marquee', 'about', 'release', 'products'];

/**
 * Which of the baked-in sections this layout does NOT contain, as the class
 * names the stylesheet already keys off.
 *
 * ── WHAT THIS REPLACES, AND WHY IT IS THE WHOLE POINT ───────────────────────
 *
 * index.html hides these before first paint by reading localStorage — a note
 * storefront.js left on the PREVIOUS visit. That is a memory, not a fact, and
 * it is wrong in exactly the two cases that matter most:
 *
 *   a first-ever visitor      has no note at all, so every default section
 *                             paints and is then hidden in front of them.
 *   the visit after a change  has last time's note, so the page paints the
 *                             OLD layout and corrects itself.
 *
 * The live homepage leads with a hero_carousel and no static hero, so a first
 * visit paints the shipped hero, then removes it and draws a carousel over the
 * space. The document knows none of this; the edge does.
 *
 * Returned as CLASSES rather than as data for a script to act on, because a
 * class on <html> is styled by `html.zw-hide-static-hero .hero{display:none}`
 * with no JavaScript involved at all. Not "before the first script runs" —
 * before there is anything to run.
 *
 * @param {*} pb the parsed page_builder_published value
 * @returns {{classes: string[], hasStaticHero: boolean}|null} null when the
 *   layout cannot be read, which leaves the remembered answer in charge.
 */
export function layoutClasses(pb) {
  const sections = pb && Array.isArray(pb.sections) ? pb.sections : null;
  if (!sections) return null;
  /* An empty published layout means "nothing is configured", not "hide
     everything" — the shipped page is the answer then, and blanking it from
     the edge would be the worst possible failure mode for this feature. */
  const visible = sections.filter((s) => s && s.visible !== false);
  if (!visible.length) return null;
  const types = new Set(visible.map((s) => String(s.type || '')));
  const classes = [];
  const hasStaticHero = types.has('hero');
  if (!hasStaticHero) classes.push('zw-hide-static-hero');
  for (const t of DEFAULT_SECTIONS) if (!types.has(t)) classes.push('zw-hs-' + t);
  return { classes, hasStaticHero };
}

async function firstPaint(env, home) {
  const base = supabaseUrl(env);
  const key = supabaseAnonKey(env);
  if (!base || !key) return null;
  /* ── TWO REQUESTS, NOT ONE, AND THE REASON IS MEASURED ────────────────────
     This was one query for everything, on the reasoning that asking for the
     rest alongside the header costs the same round trip. It does — but it does
     NOT cost the same number of BYTES, and the stamp is raced against a 60ms
     budget:

         header_layout alone                    282 b
         the fourteen first-paint keys        5,293 b
         page_builder_published alone        13,255 b
         all of them together                18,598 b

     Measured against the deployed site, the combined read won that race
     ONE TIME IN TEN. Nine visitors in ten got a page with no stamp at all —
     every part of this file dead, silently, while every test still passed
     because they all read files.

     page_builder_published is 71% of those bytes and is wanted for ONE thing:
     which default sections the layout omits. Split out, it gets its own edge
     cache entry and its own race, so a slow read of the big row can no longer
     cost the theme, the nav and the settings their stamp too. */
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  const cf = { cacheTtl: TTL, cacheEverything: true };
  const url = (keys) => base + '/rest/v1/site_settings?select=key,value,updated_at&key=in.('
    + keys.join(',') + ')';

  const [small, big] = await Promise.all([
    fetch(url(FIRST_PAINT_KEYS.concat(['feature_flags'])), { headers, cf }),
    /* Its own failure is not the small read's failure. */
    fetch(url(['page_builder_published']), { headers, cf }).catch(() => null),
  ]);

  if (!small || !small.ok) return null;
  const rows = await small.json();
  if (!Array.isArray(rows)) return null;
  if (big && big.ok) {
    try {
      const more = await big.json();
      if (Array.isArray(more)) rows.push(...more);
    } catch (_) { /* the layout classes are skipped; nothing else is */ }
  }

  const parse = (v) => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (_) { return v; }
  };

  const byKey = {};
  const updatedAt = {};
  for (const r of rows) {
    if (!r || !r.key) continue;
    byKey[r.key] = parse(r.value);
    if (r.updated_at) updatedAt[r.key] = r.updated_at;
  }

  /* Only the keys that were actually found. A key with no row is not the same
     as a key whose value is null, and zw-data.js has to be able to tell them
     apart or a missing setting becomes a stamped null it will never re-fetch. */
  const settings = {};
  for (const k of FIRST_PAINT_KEYS) if (byKey[k] !== undefined) settings[k] = byKey[k];

  const hdr = byKey.header_layout;
  return {
    html: attrsFrom(hdr, updatedAt.header_layout),
    body: bodyAttrsFrom(hdr),
    classes: layoutClasses(byKey.page_builder_published),
    nav: navStripHtml(byKey.nav_menu),
    search: searchAttr(byKey.feature_flags),
    /* The page's own theme beats the store default where there is one — see
       themeAttrs. Only the homepage has a page_builder_published to speak for
       it; every other route falls through to the default, which is what they
       actually render. */
    theme: themeAttrs(byKey.theme_modes, home ? byKey.page_builder_published : null),
    settings,
    updatedAt,
  };
}

/**
 * Which theme the store defaults to, right now.
 *
 * ── WHY AN ATTRIBUTE AND NOT THE WHOLE RECORD ───────────────────────────────
 *
 * The pre-paint block in every page decides the ground and the text colour
 * before a stylesheet is matched, and it decides them from localStorage — the
 * settings row as it looked on this visitor's LAST visit. Empty on a first
 * visit; stale on the visit after the shop changes its theme.
 *
 * It does not need the row. The default theme's actual colours are already in
 * the page as a real stylesheet rule, baked by stamp-theme-default.js and
 * scoped to html[data-zw-theme-stamp]. The only thing the pre-paint block
 * cannot work out on its own is whether that BAKE IS STILL THE RIGHT ONE, and
 * that is one string: the id of the default today.
 *
 * So two attributes rather than a JSON blob. The pre-paint block is inlined
 * into fourteen pages and measured against a byte budget — putting the settings
 * JSON in there ran 243 bytes over and told it nothing these do not.
 *
 * data-zw-theme-default is only written when the base is one the stylesheet
 * knows. An unrecognised value there is worse than none: the block treats it as
 * a learned answer and paints a ground for a theme that does not exist.
 */
/* ── THE CATEGORY STRIP, WHICH SHIPPED SOMEBODY ELSE'S ANSWER ────────────────
 *
 * index.html bakes four category links into its markup — Jackets, T-Shirts,
 * Sweatpants, Socks — and nav-menu.js replaces the lot with what the store
 * actually configured, which here is men / Women / New. Four long words become
 * three short ones, so the strip is visibly wider on the first frame and then
 * collapses. That is the "wrong distancing that fixes itself".
 *
 * The edge already reads nav_menu — it is one of the first-paint keys — so it
 * can write the real labels into the document and nav-menu.js then re-renders
 * the SAME labels, which is a repaint nobody can see.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * resolveItem() in nav-menu.js needs the CATALOGUE: it builds each item's
 * mega-menu from the product taxonomy, and it DROPS a gender or a tag that has
 * no products. None of that is knowable here without a second, much larger
 * read, and a copy of that logic at the edge is the duplication this codebase
 * has been bitten by before.
 *
 * It does not have to be. nav-menu.js already has a branch for exactly this
 * situation — the taxonomy has not arrived yet — and it renders the top-level
 * labels with no mega-menu:
 *
 *     if (!tax || tax.empty) return { label: label, url: landing, columns: [] };
 *
 * This reproduces THAT branch and nothing else. The markup is the same shape
 * nav-menu.js emits for a column-less item, so the strip measures the same
 * before and after.
 *
 * The one case it can still be wrong about is an item the catalogue would drop:
 * a gender or tag with no products would be stamped and then removed. That is a
 * far smaller shift than the one it fixes, and on this store nothing is dropped
 * — Men has 5 products, Women 2, the New tag 4.
 *
 * tests/the-header-categories-do-not-jump.test.js holds this to resolveItem's
 * no-taxonomy branch, the same way mirrorSpec is held to mirror().
 */
const NAV_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const navEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => NAV_ESC[c]);

/* nav-menu.js's safeUrl, character for character. A url this rejects becomes
   '#' there too, so stamping one it would refuse is not possible. */
function navSafeUrl(u) {
  const v = String(u == null ? '' : u).trim();
  if (!v || v.slice(0, 2) === '//') return '#';
  if (/^(?:javascript|data|vbscript|file):/i.test(v)) return '#';
  if (/^[#/]/.test(v)) return v;
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(v)) return v;
  if (/^[\w][\w./?=&%#+-]*$/.test(v)) return v;
  return '#';
}

/**
 * The top-level strip, as nav-menu.js would render it before the catalogue
 * lands. Returns '' when there is nothing trustworthy to write, which leaves
 * the baked markup exactly as it was.
 */
export function navStripHtml(navMenu) {
  const items = Array.isArray(navMenu) ? navMenu : null;
  if (!items || !items.length) return '';
  const out = [];
  for (const item of items) {
    if (!item || !item.label) continue;
    const label = item.label;
    const type = item.type || (item.gender ? 'gender' : (item.tag ? 'tag' : 'link'));
    let url = '';
    if (type === 'gender') {
      const gender = item.gender || item.label;
      url = item.url || ('landing.html?page=' + encodeURIComponent(String(gender).toLowerCase()));
    } else if (type === 'tag') {
      const tag = item.tag || label;
      url = item.url || ('landing.html?tag=' + encodeURIComponent(tag));
    } else {
      url = item.url ? navSafeUrl(item.url) : '';
    }
    /* A custom link with no url is a mega-menu trigger, not a link — the same
       distinction nav-menu.js draws, and it changes the element type. */
    const top = url
      ? '<a href="' + navEsc(url) + '" class="nav-link">' + navEsc(label) + '</a>'
      : '<button type="button" class="nav-link zw-navtrigger">' + navEsc(label) + '</button>';
    out.push('<div class="zw-navitem">' + top + '</div>');
  }
  return out.join('');
}

class NavStamp {
  constructor(html) { this.html = html; }
  element(el) { el.setInnerContent(this.html, { html: true }); }
}

/**
 * Is the search magnifier on, for everybody, without needing to know who this
 * visitor is?
 *
 * The header pre-paint draws the magnifier from a localStorage flag
 * storefront-features.js wrote on the LAST visit, so a first-ever visitor
 * watches it pop in when the module arrives. The flag row answers that — but
 * only sometimes, and the "sometimes" is the whole design here.
 *
 * A flag is { enabled, rollout }. Two of the three cases are the same for every
 * visitor and can be stamped:
 *
 *     enabled: false                 -> '0', nobody gets it
 *     enabled: true, rollout >= 100  -> '1', everybody does
 *     enabled: true, rollout 1..99   -> NOT STAMPED
 *
 * The third depends on a sticky per-visitor bucket flags.js keeps in the
 * browser, and the edge cannot see it. Guessing would put the magnifier in
 * front of somebody the rollout excludes and then take it away, which is worse
 * than the flicker being fixed. Absent means the pre-paint falls back to the
 * cache, which is exactly the behaviour it has today.
 *
 * @returns {'0'|'1'|''} '' when there is nothing certain to say.
 */
export function searchAttr(featureFlags) {
  const root = (featureFlags && typeof featureFlags === 'object') ? featureFlags : null;
  if (!root) return '';
  const bag = (root.flags && typeof root.flags === 'object') ? root.flags : root;
  const f = bag.feature_search;
  if (f === undefined || f === null) return '';
  /* A bare boolean is a legal shape for a flag row that predates rollouts. */
  if (typeof f === 'boolean') return f ? '1' : '0';
  if (typeof f !== 'object') return '';
  if (f.enabled === false) return '0';
  if (f.enabled !== true) return '';
  const rollout = f.rollout === undefined ? 100 : Number(f.rollout);
  if (!Number.isFinite(rollout)) return '';
  if (rollout >= 100) return '1';
  if (rollout <= 0) return '0';
  return '';
}

const BASES = { light: 1, 'super-light': 1, dark: 1 };

export function themeAttrs(tm, pb) {
  const v = (tm && typeof tm === 'object') ? tm : null;
  const id = v && typeof v.default === 'string' ? v.default.trim() : '';
  if (!id) return null;
  const modes = Array.isArray(v.modes) ? v.modes : [];
  const baseById = {};
  for (const m of modes) if (m && typeof m.id === 'string' && BASES[m.base]) baseById[m.id] = m.base;

  /* ── THE PAGE'S THEME BEATS THE STORE'S DEFAULT, BECAUSE IT WINS LATER ────
     Two rows answer "what colour is this page" and they disagree on the live
     store:

         theme_modes.default            imported-mslmiae8, whose base is LIGHT
         page_builder_published.theme   "dark"

     The pre-paint block reads the first and paints a light ground; storefront.js
     applies the second a moment later and the homepage turns dark. An incognito
     visitor — no cached choice, no cached record — watched exactly that on every
     single load, which is what "it shows light before switching to dark" is.

     Whoever wins LAST is the page's real theme, so that is what gets stamped.
     Only the homepage has a page_builder_published to speak for it; the caller
     passes null for every other route, which falls through to the default they
     genuinely render. */
  const page = (pb && typeof pb === 'object' && typeof pb.theme === 'string') ? pb.theme.trim() : '';
  const base = BASES[page] ? page : (baseById[id] || '');

  return {
    id,
    /* Only when the stylesheet has a token set for it. An unrecognised base is
       worse than none: the pre-paint block treats it as a learned answer and
       paints a ground for a theme that does not exist. */
    base,
    baseById,
  };
}

/**
 * Rewrite the baked theme answer to today's, on the way out.
 *
 * stamp-theme-default.js bakes the default theme's real palette into every page
 * as a stylesheet rule scoped to html[data-zw-theme-stamp]. That is the whole
 * answer for a visitor with nothing stored — until the shop changes its default,
 * at which point the bake is a confident wrong answer that nothing on the page
 * can challenge: the pre-paint block compares it against the id it read from
 * localStorage, and a first-ever visitor has none.
 *
 * The edge has both halves. It removes the bake when it is out of date and
 * corrects the base either way, so the pre-paint block finds attributes that
 * already tell the truth and needs no extra code — which matters, because that
 * block is inlined into fourteen pages and is up against a byte budget.
 *
 * A visitor who PICKED a theme is still handled in the browser: their choice
 * lives in localStorage, the edge cannot see it, and the pre-paint block's own
 * comparison already drops the bake for them. The two are complementary and
 * neither can undo the other.
 */
class ThemeStamp {
  constructor(theme) { this.theme = theme; }
  element(el) {
    const { id, base, baseById } = this.theme;
    if (base) el.setAttribute('data-zw-theme-default', base);
    const baked = String(el.getAttribute('data-zw-theme-stamp') || '');
    if (!baked) return;
    /* Two ways the baked palette can be the wrong one, and the second is the
       one that was actually happening:

         it is not the default any more   the shop picked another theme
         it IS the default, but this PAGE renders on a different ground

     On the live store the bake is the default AND light, while the homepage
     renders dark. Comparing ids alone kept it, so a light theme's tokens sat
     on a dark ground for the first frame. */
    const bakedBase = baseById[baked] || '';
    if (baked !== id || (base && bakedBase && bakedBase !== base)) {
      el.removeAttribute('data-zw-theme-stamp');
    }
  }
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

/**
 * Add classes to <html> without discarding the ones already on it.
 *
 * setAttribute REPLACES, and <html> carries classes the preboot scripts and the
 * theme stamp put there. Merging rather than assigning is the difference
 * between hiding a section and clearing the page's theme.
 */
class ClassStamp {
  constructor(classes, marker) { this.classes = classes; this.marker = marker; }
  element(el) {
    const have = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const seen = new Set(have);
    for (const c of this.classes) if (!seen.has(c)) { seen.add(c); have.push(c); }
    if (have.length) el.setAttribute('class', have.join(' '));
    /* The marker is what tells index.html's preboot to stop guessing. Without
       it the preboot would apply its remembered answer ON TOP of the stamped
       one and could hide a section this layout actually has — a remembered
       answer being wrong is exactly why the stamp exists. */
    if (this.marker) el.setAttribute('data-zw-pb', '1');
  }
}

/**
 * Put the first-paint settings into the document as inline JSON.
 *
 * zw-data.js reads this instead of making a request, so every module that goes
 * through the settings broker has its answer before the first frame rather than
 * after a round trip. Prepended to <head> so it is parsed before the stylesheets
 * and before any deferred script exists to look for it.
 *
 * `type="application/json"` is not executable — the browser will not run it, the
 * CSP does not have to allow it, and nothing here is ever interpreted as code.
 * The only sequence that could end the block early is a literal "</script>", so
 * the forward slash is escaped; the JSON parser reads \/ as / and the HTML
 * parser never sees a closing tag.
 */
class HeadStamp {
  constructor(payload) { this.payload = payload; }
  element(el) {
    const json = JSON.stringify(this.payload).replace(/<\/script/gi, '<\\/script');
    el.prepend(
      '<script type="application/json" id="zw-first-paint">' + json + '</script>',
      { html: true },
    );
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  let url;
  try { url = new URL(request.url); } catch (_) { return context.next(); }

  /* ── /sitemap.xml is answered here ────────────────────────────────────────
     Not because a middleware is the natural home for it, but because a file at
     functions/sitemap.xml.js does NOT become a route — measured on the deployed
     site, where it returned 404 while the static file it replaced had already
     been deleted. The dot in the filename is the reason. This middleware is
     demonstrably reached in production (it is what stamps the header
     arrangement into every page), so it is the one place the route is certain.
     Failure falls through to whatever the site would otherwise serve. */
  if (request.method === 'GET' && url.pathname === '/sitemap.xml') {
    try { return await buildSitemap(env); } catch (_) { /* fall through */ }
  }

  /* Not worth a settings read: API routes are not pages, a non-GET is not a
     page load, and a builder preview must show the DRAFT — stamping the
     published arrangement there is the one thing that would actively mislead. */
  const skip = request.method !== 'GET'
    || url.pathname.startsWith('/api/')
    || /[?&]builder=1(?:&|$)/.test(url.search);

  /* Started before the page is fetched so the two overlap. A rejection here
     must not take the page down with it. */
  /* Only the homepage is described by page_builder_published, so only it gets
     that row's theme. /index.html is the same document by another name and is
     routed here too. */
  const home = url.pathname === '/' || url.pathname === '/index.html';
  const pending = skip ? null : firstPaint(env, home).catch(() => null);

  /* ── THE READ HAS TO OUTLIVE THE RACE, OR THE CACHE NEVER WARMS ─────────
     The note below says giving up on the WAIT is not giving up on the REQUEST.
     It was, though: without waitUntil the Worker is torn down the moment the
     response is returned and the in-flight fetch is cancelled with it. So the
     edge cache was never populated, every visitor raced a COLD read against
     60ms, and the stamp landed one time in ten measured against the deployed
     site. The comment described the behaviour anybody would have wanted; this
     line is what makes it true. */
  if (pending && typeof context.waitUntil === 'function') {
    try { context.waitUntil(pending); } catch (_) {}
  }

  const res = await context.next();
  if (skip) return res;

  try {
    const ct = (res.headers && res.headers.get('content-type')) || '';
    if (!ct.includes('text/html')) return res;

    /* ── THE STAMP GETS A BUDGET, NOT A BLANK CHEQUE ─────────────────────────
       This used to `await pending` outright, so on a cold settings cache the
       whole page waited for a Supabase round trip before a single byte of HTML
       went out. That is a first-frame nicety holding up the first frame.

       The file already says what happens without it: "This can make the first
       frame right; it cannot make the page wrong." The page still carries the
       baked answer, still corrects from the visitor's cache, still corrects
       from the runtime fetch. So a slow read is simply not worth waiting for —
       sixty milliseconds is long enough for a warm edge cache, which is the
       case that actually benefits, and short enough that a cold one costs
       almost nothing.

       Deliberately racing rather than lowering the fetch timeout: the read is
       still allowed to finish and populate the edge cache for the NEXT
       visitor. Giving up on the wait is not the same as giving up on the
       request. */
    const attrs = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(null), STAMP_BUDGET_MS)),
    ]);
    if (!attrs) return res;
    const hasSettings = attrs.settings && Object.keys(attrs.settings).length > 0;
    const hasClasses = attrs.classes && attrs.classes.classes.length > 0;
    /* `data-zw-pb` is written whenever the layout was READ, even when it turns
       out to hide nothing — "this layout has every default section" is an
       answer, and the preboot must stop guessing on the strength of it rather
       than only when something needs hiding. */
    const readLayout = !!attrs.classes;
    if (!attrs.html && !attrs.body && !hasSettings && !readLayout && !attrs.theme && !attrs.nav && !attrs.search) return res;
    let rw = new HTMLRewriter();
    if (attrs.html) rw = rw.on('html', new Stamp(attrs.html));
    if (attrs.theme) rw = rw.on('html', new ThemeStamp(attrs.theme));
    if (attrs.search) rw = rw.on('html', new Stamp({ 'data-zw-search': attrs.search }));
    if (attrs.nav) rw = rw.on('#nav-category-links', new NavStamp(attrs.nav));
    if (readLayout) rw = rw.on('html', new ClassStamp(hasClasses ? attrs.classes.classes : [], true));
    if (attrs.body) rw = rw.on('body', new Stamp(attrs.body));
    if (hasSettings) {
      rw = rw.on('head', new HeadStamp({
        settings: attrs.settings,
        updatedAt: attrs.updatedAt || {},
      }));
    }
    return rw.transform(res);
  } catch (_) {
    return res;   // the page as it was, which is still a working page
  }
}
