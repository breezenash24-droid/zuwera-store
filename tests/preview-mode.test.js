/* The admin preview link: token signing, what a token can reach, and the
   gating in both directions (button hidden, server enforcing). */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  \u2014 ' + e : '')); } };

/* Load _preview.js with its ESM wrapper stripped. */
function loadPreview() {
  let src = fs.readFileSync(R + 'functions/api/_preview.js', 'utf8').replace(/^export /gm, '');
  src += '\n;module.exports={mintPreviewToken,verifyPreviewToken,PREVIEW_TTL_SECONDS};';
  const mod = { exports: {} };
  new Function('module', 'crypto', 'TextEncoder', 'btoa', 'atob', src)(
    mod, require('crypto').webcrypto, TextEncoder,
    (s) => Buffer.from(s, 'binary').toString('base64'),
    (s) => Buffer.from(s, 'base64').toString('binary')
  );
  return mod.exports;
}
const { mintPreviewToken, verifyPreviewToken, PREVIEW_TTL_SECONDS } = loadPreview();
const env = { SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests' };
const otherEnv = { SUPABASE_SERVICE_ROLE_KEY: 'a-different-deployments-key' };

(async function () {
  console.log('\n  preview tokens\n');

  const token = await mintPreviewToken(env, { sub: 'admin-1', perms: ['builder_edit'] });
  ok('mints a token', typeof token === 'string' && token.split('.').length === 2);

  const claims = await verifyPreviewToken(env, token);
  ok('verifies its own token', !!claims && claims.sub === 'admin-1');
  ok('carries the granting permission', claims.perms.join() === 'builder_edit');
  ok('expires in hours, not days', PREVIEW_TTL_SECONDS > 0 && PREVIEW_TTL_SECONDS <= 60 * 60 * 6,
    PREVIEW_TTL_SECONDS + 's');

  console.log('\n  a token cannot be forged');
  ok('rejects a tampered payload',
    await verifyPreviewToken(env, 'eyJzdWIiOiJoYWNrZXIifQ.' + token.split('.')[1]) === null);
  ok('rejects a tampered signature', await verifyPreviewToken(env, token.split('.')[0] + '.AAAA') === null);
  ok('rejects a token signed with another key', await verifyPreviewToken(otherEnv, token) === null);
  ok('rejects garbage', await verifyPreviewToken(env, 'not-a-token') === null);
  ok('rejects an empty token', await verifyPreviewToken(env, '') === null);
  ok('rejects a token with no signature', await verifyPreviewToken(env, token.split('.')[0]) === null);

  // Expiry is enforced, not decorative.
  const expired = await (async () => {
    const real = Date.now;
    Date.now = () => real() - (PREVIEW_TTL_SECONDS + 60) * 1000;
    const t = await mintPreviewToken(env, { sub: 'admin-1', perms: [] });
    Date.now = real;
    return t;
  })();
  ok('rejects an expired token', await verifyPreviewToken(env, expired) === null);

  ok('no signing key configured → mints nothing (fails closed)',
    await mintPreviewToken({}, { sub: 'x', perms: [] }) === null);
  ok('…and verifies nothing', await verifyPreviewToken({}, token) === null);

  /* Revocation. A link that has gone somewhere you did not intend can otherwise
     only be waited out, so every token records the generation it was minted
     under and the admin's "Revoke preview links" moves the generation on. */
  console.log('\n  revocation');
  {
    const revEnv = { SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests', SUPABASE_URL: 'https://example.test' };
    let generation = 3;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ value: generation }] });
    try {
      const live = await mintPreviewToken(revEnv, { sub: 'admin-1', perms: ['builder_edit'] });
      ok('verifies while the generation matches', (await verifyPreviewToken(revEnv, live)) !== null);
      generation = 4;                                   // admin pressed Revoke
      ok('stops verifying the moment links are revoked', (await verifyPreviewToken(revEnv, live)) === null);
      const fresh = await mintPreviewToken(revEnv, { sub: 'admin-1', perms: ['builder_edit'] });
      ok('a link minted after the revoke still works', (await verifyPreviewToken(revEnv, fresh)) !== null);
    } finally {
      globalThis.fetch = realFetch;
    }
    ok('a token predating revocation verifies while nothing has been revoked',
      (await verifyPreviewToken(env, token)) !== null);
  }

  console.log('\n  what a token can reach');
  {
    const cfg = fs.readFileSync(R + 'functions/api/preview-config.js', 'utf8');
    const keys = (cfg.match(/const DRAFT_KEYS = \[([^\]]*)\]/) || [])[1] || '';
    const list = (keys.match(/'[^']+'/g) || []).map(s => s.slice(1, -1));
    /* An explicit roster, not a pattern, so widening it is a decision somebody
       had to write down. nav_menu_draft / announcement_bar_draft /
       text_overrides_draft joined it when the builder learned to edit text
       outside a section: they are storefront content drafts, the same class as
       product_page_draft, and without them "Preview live" showed the published
       nav, bar and page copy around draft sections — the one button whose whole
       job is showing unpublished work was where those edits never appeared. */
    ok('only draft storefront keys are readable', list.length > 0 &&
      list.every(k => /^(page_builder|landing_pages|builder_theme|builder_nav|product_page_draft|collection_page_draft|nav_menu_draft|announcement_bar_draft|text_overrides_draft|header_layout_draft)$/.test(k)),
      list.join(','));
    ok('and every one of them is a draft, never a live key',
      list.every(k => /_draft$/.test(k) || /^(page_builder|landing_pages|builder_theme|builder_nav)$/.test(k)),
      'the live halves are public already and have no business behind a token');
    ok('no published key is exposed through it', !list.some(k => /_published$/.test(k)));
    // Strip comments — the file's own doc block names these tables to say it
    // does NOT read them, and matching prose would pass or fail for the wrong
    // reason either way.
    const code = cfg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('the code touches no other table', !/orders|profiles|api_key|commerce_config/.test(code));
    ok('…and reads exactly one table', (code.match(/\/rest\/v1\/(\w+)/g) || []).join() === '/rest/v1/site_settings');
    ok('the allow-list is re-checked per row, not just in the query',
      /DRAFT_KEYS\.indexOf\(row\.key\) === -1/.test(cfg));
    ok('drafts are never cached by a shared cache', /no-store, private/.test(cfg));
    ok('every rejection returns the same message',
      (cfg.match(/not valid or has expired/g) || []).length === 1);
  }

  console.log('\n  gating');
  {
    const tok = fs.readFileSync(R + 'functions/api/preview-token.js', 'utf8');
    ok('the session must be valid', /auth\/v1\/user/.test(tok));
    ok('the profile must be an admin', /prof\.role !== 'admin'/.test(tok));
    ok('the role must carry builder_edit', /permsHave\(perms, 'builder_edit'\)/.test(tok));
    ok('missing service key fails closed', /Server not configured/.test(tok));

    const admin = fs.readFileSync(R + 'admin.html', 'utf8');
    ok('the admin button is hidden by default', /id="previewUnpublishedBtn"[^>]*display:none/.test(admin));
    ok('…and revealed only for builder_edit',
      /previewUnpublishedBtn[\s\S]{0,200}can\('builder_edit'\) \? 'flex' : 'none'/.test(admin));

    const builder = fs.readFileSync(R + 'builder.html', 'utf8');
    ok('the builder has the same entry point', /openUnpublishedPreview\(\)/.test(builder));
    ok('…and saves the draft before previewing it', /await saveDraft\(\);/.test(builder));
  }

  console.log('\n  storefront side');
  {
    const pv = fs.readFileSync(R + 'preview-mode.js', 'utf8');
    ok('resolves to null when there is no preview, so normal loads are unaffected',
      /__zwPreviewReady = Promise\.resolve\(null\)/.test(pv));
    ok('shows a banner so a draft is never mistaken for the live site', /zw-preview-bar/.test(pv));
    ok('offers a way out of preview mode', /Exit preview/.test(pv));
    ok('carries the token across in-site links', /searchParams\.set\('zwpreview'/.test(pv));
    /* The token used to be written nowhere at all, which read as the safest
       possible rule and was not: it meant the working token sat in the address
       bar of every page for the whole session, which is how these actually
       escape — someone copies the URL they are looking at. It now moves into
       sessionStorage and comes straight out of the URL.

       So the invariant is no longer "never stored", it is "never stored
       anywhere that outlives the tab". sessionStorage is cleared when the tab
       closes; localStorage would survive a browser restart and be readable by
       every other tab on the origin, which is the thing worth forbidding. */
    ok('never writes the token to localStorage',
      ![...pv.matchAll(/localStorage\.setItem\(([^)]*)\)/g)].some(m => /token/i.test(m[1])));
    ok('takes the token out of the address bar once it has been read',
      /searchParams\.delete\('zwpreview'\)/.test(pv) && /history\.replaceState/.test(pv));
    ok('drops the tab copy on exit', /removeItem\(SESSION_KEY\)/.test(pv));

    const home = fs.readFileSync(R + 'storefront.js', 'utf8');
    ok('the homepage renders the draft through the published path (one renderer)',
      /settings\.page_builder_published = preview\.page_builder/.test(home));
    const land = fs.readFileSync(R + 'landing.js', 'utf8');
    ok('landing pages take drafts from the verified endpoint', /pv\.landing_pages/.test(land));
    ok('…and a previewed draft is never cached as if it were live',
      /fromPreview\) preview = true/.test(land));

    // Load order: preview-mode must run before the renderers read it.
    ['index.html', 'landing.html', 'drop001.html', 'product.html'].forEach(f => {
      const s = fs.readFileSync(R + f, 'utf8');
      const pvAt = s.indexOf('preview-mode.js');
      const first = s.search(/<script src="[^"]*\.js/);
      ok(f + ': preview-mode loads first', pvAt > -1 && pvAt <= first + 60, 'at ' + pvAt + ' vs ' + first);
    });
  }

  /* ── every builder tab now means the same thing by Save and Publish ─────── */
  console.log('\n  save / publish are consistent');
  {
    const builder = fs.readFileSync(R + 'builder.html', 'utf8');
    const save = fs.readFileSync(R + 'functions/api/save-page-builder.js', 'utf8');

    ok('the Product tab saves a draft, not the live key', /key:'product_page_draft'/.test(builder));
    ok('the Collection tab saves a draft, not the live key', /key:'collection_page_draft'/.test(builder));
    ok('neither writes the live key directly any more',
      !/key:'product_page'[^_]/.test(builder) && !/key:'collection_page'[^_]/.test(builder));
    ok('both say the draft is not live yet',
      (builder.match(/Draft saved\. Press Publish to make it live\./g) || []).length === 2);

    ok('Publish covers the Product tab', /curTab==='product'\).*pdpSave\(true\)/.test(builder));
    ok('Publish covers the Collection tab', /curTab==='collection'\).*saveCollectionCfg\(true\)/.test(builder));
    ok('publishing copies the draft onto the live key', /DRAFT_TO_LIVE\[key\] && published/.test(save));
    ok('the draft keys are allowed by the save endpoint',
      /'product_page_draft'/.test(save) && /'collection_page_draft'/.test(save));

    ok('the builder opens on the draft, falling back to live',
      /product_page_draft','product_page'/.test(builder) && /collection_page_draft','collection_page'/.test(builder));

    // The live keys keep their names, so nothing on the storefront has to change
    // and no new key needs adding to the anon-read policy.
    const pv = fs.readFileSync(R + 'functions/api/preview-config.js', 'utf8');
    ok('the preview serves drafts under the names the storefront already reads',
      /DRAFT_ALIAS/.test(pv) && /product_page_draft: 'product_page'/.test(pv));

    const pdp = fs.readFileSync(R + 'functions/api/product-page-config.js', 'utf8');
    ok('the product page serves its draft under a valid token', /verifyPreviewToken\(env, token\)/.test(pdp));
    ok('…and falls back to live when no draft exists yet',
      /wanted === 'product_page_draft' && \(v === undefined \|\| v === null\)/.test(pdp));
    const gal = fs.readFileSync(R + 'pdp-gallery.js', 'utf8');
    ok('the product page passes the token through', /zwpreview=' \+ encodeURIComponent\(_pv\)/.test(gal));
    const coll = fs.readFileSync(R + 'drop001.html', 'utf8');
    ok('the collection page takes its draft from the preview', /_pv\.collection_page/.test(coll));
  }

  /* ── the preview banner ─────────────────────────────────────────────────── */
  console.log('\n  preview banner');
  {
    const pv = fs.readFileSync(R + 'preview-mode.js', 'utf8');
    ok('sits above the announcement bar and the nav', /z-index:2147483000/.test(pv));
    ok('its colour is configurable', /zw_preview_bar_colour/.test(pv));
    ok('…and only accepts a colour, not arbitrary CSS', /\^#\[0-9a-f\]\{3,8\}\$/i.test(pv));
    ok('folds away to a handle so the real page furniture can be judged',
      /zw-preview-tab/.test(pv) && /setCollapsed/.test(pv));
    ok('…and gives the page its space back when folded',
      /paddingTop = on \? '' :/.test(pv));
    ok('the choice survives clicking through the site', /sessionStorage\.setItem\('zw_preview_collapsed'/.test(pv));

    const admin = fs.readFileSync(R + 'admin.html', 'utf8');
    ok('the colour is an admin setting', /id="settPreviewBarColour"/.test(admin));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
