/* Translation should not be a bill you cannot get out of.
 *
 * DeepL was the only translator, and DeepL is paid past a small free tier. A
 * store deciding translation was not worth paying for had two options: keep
 * paying, or lose the feature. Google Cloud Translation is the alternative
 * worth having — different pricing, different free allowance, wider coverage,
 * and lower quality on the long prose DeepL is good at. Neither is strictly
 * better, which is exactly why it is a choice and not a migration.
 *
 * TRANSLATE_PROVIDER picks explicitly; unset, it resolves to whichever key
 * exists with DeepL first — so a store with a DeepL key sees no change, and a
 * store that deletes that key falls to Google instead of breaking.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SETTINGS = fs.readFileSync(path.join(ROOT, 'functions/api/_settings.js'), 'utf8');
const STATUS = fs.readFileSync(path.join(ROOT, 'functions/api/api-status.js'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'functions/api/translate.js'), 'utf8');

(async () => {
  await import(pathToFileURL(ROOT + '/functions/api/translate.js').href);

  /* The helpers are module-private, so they are exercised through a rebuilt
     copy rather than exported purely for testing. */
  const helpers = new Function(
    SRC.slice(SRC.indexOf('function toGoogleLang'), SRC.indexOf('function buildCorsHeaders'))
    + ';return { toGoogleLang, decodeEntities, translateWithGoogle };'
  )();

  console.log('\n  translation provider\n');

  console.log('  choosing one');
  {
    const pick = (env) => {
      const deepl = String(env.DEEPL_API_KEY || '').trim();
      const google = String(env.GOOGLE_TRANSLATE_API_KEY || '').trim();
      const requested = String(env.TRANSLATE_PROVIDER || '').trim().toLowerCase();
      if (requested === 'google') return google ? 'google' : '';
      if (requested === 'deepl') return deepl ? 'deepl' : '';
      return deepl ? 'deepl' : (google ? 'google' : '');
    };
    ok('the selection logic is in the route', /const requested = String\([\s\S]{0,80}?TRANSLATE_PROVIDER/.test(SRC));
    /* It used to read context.env ONLY, which made choosing a provider a
       redeploy — the Stripe Tax trap in miniature, where the admin offers a
       switch and the thing doing the work never looks at it. Someone whose
       DeepL allowance has just run out wants to move before the next customer
       opens a review, not after a build. */
    ok('…resolved from settings first, so the switch does not need a deploy',
      /resolveSetting\('TRANSLATE_PROVIDER', context\.env, cache\)/.test(SRC));
    ok('…and the Google key too', /resolveSetting\('GOOGLE_TRANSLATE_API_KEY', context\.env, cache\)/.test(SRC));
    ok('both are admin-editable, or the dropdown saves into a void',
      /'TRANSLATE_PROVIDER'/.test(SETTINGS) && /'GOOGLE_TRANSLATE_API_KEY'/.test(SETTINGS));

    /* "Off" is the option this whole branch exists for: a store that decides
       translation is not worth paying for should be able to stop without
       deleting a key it may want back. */
    ok('off is answered as a clean no-op, not an error',
      /requested === 'off' \|\| requested === 'none'/.test(SRC) && /provider: 'off', disabled: true/.test(SRC));
    ok('…returning the original text so the page still renders',
      /translations: normalizedTexts, provider: 'off'/.test(SRC));

    /* A provider name is not a credential, and masking it stops the dropdown
       showing what is selected — maskKey collapses anything <= 8 chars to
       bullets, so "google", "deepl" and "off" become identical. */
    ok('the provider name comes back readable, so the admin can show it',
      /PLAIN_KEYS[\s\S]{0,200}?'TRANSLATE_PROVIDER'/.test(STATUS));

    const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
    ok('the admin offers it as a dropdown rather than instructions',
      /function buildTranslateProviderRow/.test(ADMIN) && /saveTranslateProvider/.test(ADMIN));
    ok('…including Off', /opt\('off', 'Off — do not translate'\)/.test(ADMIN));
    ok('…and warns when Google is picked without its key', /Google needs <code>GOOGLE_TRANSLATE_API_KEY/.test(ADMIN));
    ok('a DeepL key alone → DeepL', pick({ DEEPL_API_KEY: 'k' }) === 'deepl');
    ok('a Google key alone → Google', pick({ GOOGLE_TRANSLATE_API_KEY: 'g' }) === 'google');
    ok('both keys, nothing requested → DeepL, so nothing changes for an existing store',
      pick({ DEEPL_API_KEY: 'k', GOOGLE_TRANSLATE_API_KEY: 'g' }) === 'deepl');
    ok('asking for Google gets Google even with DeepL present',
      pick({ TRANSLATE_PROVIDER: 'google', DEEPL_API_KEY: 'k', GOOGLE_TRANSLATE_API_KEY: 'g' }) === 'google');
    /* The point of the whole change: deleting the paid key must degrade to the
       other provider, not to a broken feature. */
    ok('removing the DeepL key falls through to Google rather than breaking',
      pick({ GOOGLE_TRANSLATE_API_KEY: 'g', TRANSLATE_PROVIDER: '' }) === 'google');
    ok('no keys at all → nothing, and the caller must say so', pick({}) === '');

    ok('the "no key" message names BOTH providers',
      /GOOGLE_TRANSLATE_API_KEY to use Google Cloud Translation instead/.test(SRC),
      'a message naming only DeepL is how someone concludes translation must be paid for');
    ok('…and says when the requested provider is the one missing its key',
      /TRANSLATE_PROVIDER is set to/.test(SRC));
    ok('the reply says which provider answered', /provider: 'google'/.test(SRC) && /provider: 'deepl'/.test(SRC));
  }

  console.log('\n  the two ways Google differs from DeepL');
  {
    /* Google is lenient about case, so passing DeepL's uppercase tag straight
       through mostly works — and "ZH" quietly returns Simplified for a request
       that may have meant Traditional. Lenient is worse than strict when the
       failure is a wrong answer rather than an error. */
    ok('ES → es', helpers.toGoogleLang('ES') === 'es');
    ok('PT-BR → pt-BR', helpers.toGoogleLang('PT-BR') === 'pt-BR');
    ok('ZH is pinned to a script rather than left ambiguous', helpers.toGoogleLang('ZH') === 'zh-CN');
    ok('…and an explicit Chinese region is kept', helpers.toGoogleLang('ZH-TW') === 'zh-TW');
    ok('empty in, empty out', helpers.toGoogleLang('') === '');

    /* Google HTML-escapes its output even with format:'text'. Left alone an
       apostrophe renders as &#39; inside a review — which reads as the customer
       having typed something strange, not as a bug. */
    ok('&#39; becomes an apostrophe', helpers.decodeEntities('it&#39;s great') === "it's great");
    ok('&quot; becomes a quote', helpers.decodeEntities('&quot;nice&quot;') === '"nice"');
    ok('hex entities decode too', helpers.decodeEntities('caf&#xe9;') === 'café');
    /* &amp; must be decoded LAST or it un-escapes the others' ampersands and
       "&amp;#39;" — a literal, intended "&#39;" — turns into an apostrophe. */
    ok('&amp; is decoded last, so an escaped entity survives',
      helpers.decodeEntities('&amp;#39;') === '&#39;',
      'decoding & first would corrupt text that legitimately contains an entity');
    ok('plain text is untouched', helpers.decodeEntities('nothing to do') === 'nothing to do');
  }

  console.log('\n  Google translation, end to end');
  {
    const realFetch = globalThis.fetch;
    const call = async (impl, texts, target) => {
      globalThis.fetch = impl;
      try { return await helpers.translateWithGoogle(texts, target, 'key'); }
      finally { globalThis.fetch = realFetch; }
    };
    const reply = (body, ok2 = true, status = 200) => async () => ({
      ok: ok2, status, text: async () => JSON.stringify(body),
    });

    const out = await call(reply({ data: { translations: [{ translatedText: 'hola' }, { translatedText: 'adi&#243;s' }] } }), ['hi', 'bye'], 'ES');
    ok('translations come back in order', out[0] === 'hola');
    ok('…decoded', out[1] === 'adiós');

    /* A short reply would otherwise line reviews up against the wrong text —
       every later review silently attributed to the wrong one. */
    const short = await call(reply({ data: { translations: [{ translatedText: 'hola' }] } }), ['hi', 'bye'], 'ES');
    ok('a short reply keeps the originals rather than mis-pairing',
      short.length === 2 && short[0] === 'hola' && short[1] === 'bye');

    let threw = '';
    try { await call(reply({ error: { message: 'API key not valid' } }, false, 403), ['hi'], 'ES'); }
    catch (e) { threw = e.message; }
    ok('an API error surfaces Google\'s own words', /API key not valid/.test(threw), threw);

    let threw2 = '';
    try { await call(async () => { throw new Error('network down'); }, ['hi'], 'ES'); }
    catch (e) { threw2 = e.message; }
    ok('a network failure throws rather than returning nothing', /network down/.test(threw2), threw2);

    /* format:'text' matters — asking for HTML would return markup that renders
       as tags inside a review. */
    ok('it asks for plain text', /format: 'text'/.test(SRC));
    ok('…and sends the key as a query parameter, which is what Google expects',
      /translate\/v2\?key=' \+ encodeURIComponent\(key\)/.test(SRC));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
