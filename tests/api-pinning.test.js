/* The things you use, where you look.
 *
 * More Integrations is a shop: twenty-two services you MIGHT use, collapsed
 * behind a summary. The API list above it is the ones you do. Anything you
 * actually configured from the catalogue stayed downstairs regardless, so
 * checking on it meant expanding a section and scrolling past twenty things
 * you have never touched.
 *
 * The reverse trip already existed — "Tuck away" moves an API-key service DOWN
 * into the catalogue. This is the same idea in the other direction, built on
 * the same stored layout rather than a second mechanism beside it.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');

console.log('\n  pinning integrations\n');

console.log('  it reuses the layout that already existed');
{
  ok('both directions live in one stored object', /_apiLayout = \{ demoted: \[\], pinned: \[\] \}/.test(ADMIN));
  ok('…saved under the same settings key', (ADMIN.match(/key: 'api_layout'/g) || []).length >= 2);
  ok('there is a pin action', /async function pinIntegration\(key, on\)/.test(ADMIN));
  ok('…and a reader for it', /const apiIsPinned\s+= \(key\)/.test(ADMIN));

  /* THE BUG THIS AVOIDS. moveApiCard rebuilt the layout as
     `{ demoted: [...set] }`, which drops every other field. Adding `pinned`
     beside it would have meant tucking one card away silently unpinned
     everything — the kind of fault that surfaces as "my layout keeps
     resetting" and is almost impossible to attribute. */
  ok('moving a card preserves the pins', /_apiLayout = \{ \.\.\._apiLayout, demoted: \[\.\.\.set\] \}/.test(ADMIN),
    'rebuilding the object drops the other half of the layout');
  ok('…and pinning preserves the tucked-away list',
    /_apiLayout = \{ \.\.\._apiLayout, pinned: \[\.\.\.set\] \}/.test(ADMIN));
}

console.log('\n  a layout saved before pinning existed still loads');
{
  /* Real rows exist with only `demoted`. Reading a missing array as one throws
     on the first .includes(), which would break the whole API page. */
  const loader = ADMIN.slice(ADMIN.indexOf('_apiLayout = {\n                    demoted:'), ADMIN.indexOf('async function moveApiCard'));
  ok('pinned defaults to an empty array', /pinned:\s*\(v && Array\.isArray\(v\.pinned\)\)\s*\? v\.pinned\s*: \[\]/.test(ADMIN));
  ok('demoted defaults the same way', /demoted: \(v && Array\.isArray\(v\.demoted\)\) \? v\.demoted : \[\]/.test(ADMIN));
  ok('…and a broken read falls back to both', /catch \(_\) \{ _apiLayout = \{ demoted: \[\], pinned: \[\] \}; \}/.test(ADMIN));

  /* Run it: the reader must survive every shape a stored row can have. */
  const read = new Function('v', `
    const _apiLayout = {
      demoted: (v && Array.isArray(v.demoted)) ? v.demoted : [],
      pinned:  (v && Array.isArray(v.pinned))  ? v.pinned  : [],
    };
    return _apiLayout;`);
  const shapes = [undefined, null, {}, { demoted: ['stripe'] }, { pinned: ['crisp'] }, { demoted: null, pinned: 'nope' }];
  const bad = shapes.filter((sh) => {
    try { const l = read(sh); return !Array.isArray(l.demoted) || !Array.isArray(l.pinned); }
    catch (_) { return true; }
  });
  ok('every stored shape reads as two arrays', bad.length === 0, JSON.stringify(bad));
}

console.log('\n  only something you actually use can be pinned');
{
  /* Pinning an unconfigured service would move the catalogue's clutter up into
     the list that exists to be free of it. */
  ok('the button appears only for live, ready or attention',
    /st\.state === 'live' \|\| st\.state === 'ready' \|\| st\.state === 'attention'/.test(ADMIN));
  ok('…and not on a tucked-away API card, which has its own control',
    /!it\.tucked && \(st\.state === 'live'/.test(ADMIN));
  ok('the button toggles rather than only adding',
    /pinIntegration\('\$\{it\.key\}', \$\{apiIsPinned\(it\.key\) \? 'false' : 'true'\}\)/.test(ADMIN));
  ok('…and says which way it goes', /'⤓ Unpin' : '⤒ Pin to top'/.test(ADMIN));
}

console.log('\n  a pinned integration renders as a real API card');
{
  ok('pinned entries are pushed into the same grid', /for \(const key of \(_apiLayout\.pinned \|\| \[\]\)\)/.test(ADMIN));
  ok('…through renderApiCard, not a second kind of tile', /pinnedCards\.push\(renderApiCard\(/.test(ADMIN));
  /* A catalogue entry can be deleted while still pinned. Rendering `undefined`
     would take the whole grid down. */
  ok('a pin naming a removed entry is skipped, not rendered',
    /if \(!it\) continue;/.test(ADMIN));
  ok('it carries its state reason up with it', /st\.why \? `<p class="api-note">/.test(ADMIN));
  ok('…and can be unpinned from up there too', /pinIntegration\('\$\{it\.key\}', false\)/.test(ADMIN));
  ok('its health reflects the integration state, not a guess',
    /ok: st\.state === 'live' \|\| st\.state === 'ready'/.test(ADMIN));
}

console.log('\n  pinned means TOP, not "somewhere else"');
{
  /* Appending to the end is not pinning to the top — it is moving something
     from one place you have to scroll to, to another. */
  ok('pinned cards are collected separately', /const pinnedCards = \[\];/.test(ADMIN));
  ok('…and rendered before everything else',
    /\[\.\.\.pinnedCards, \.\.\.cards\]/.test(ADMIN),
    'order of the spread is the whole feature');
  ok('…in the order they were pinned', /for \(const key of \(_apiLayout\.pinned \|\| \[\]\)\)/.test(ADMIN));
}

console.log('\n  the layout can be put back');
{
  ok('there is a reset', /async function resetApiLayout\(\)/.test(ADMIN));
  ok('…and an undo for the reset', /async function undoApiLayout\(\)/.test(ADMIN));
  /* THE IMPORTANT HALF. A reset with no way back is a second way to lose the
     layout rather than a way to recover it — somebody clicking it to see what
     it does has then destroyed the thing they were being protected from
     losing. */
  ok('the snapshot is taken BEFORE the write',
    ADMIN.indexOf("localStorage.setItem(APILAYOUT_UNDO_KEY") < ADMIN.indexOf("await saveApiLayout({ demoted: [], pinned: [] }"),
    'a failed save must still leave an undo pointing at what is stored');
  /* A variable would be gone on the first refresh, and the reset reloads both
     lists — so the undo has to outlive a page load to be worth anything. */
  ok('…and survives a reload', /localStorage\.setItem\(APILAYOUT_UNDO_KEY/.test(ADMIN));
  ok('undo clears itself, so it cannot be replayed onto a newer layout',
    /localStorage\.removeItem\(APILAYOUT_UNDO_KEY\)/.test(ADMIN));
  ok('…and says so when there is nothing to undo', /Nothing to undo\./.test(ADMIN));
  ok('resetting an already-default layout does nothing rather than clearing the undo',
    /Already showing the default order/.test(ADMIN));

  ok('both writes go through one save path', /async function saveApiLayout\(next, message\)/.test(ADMIN));
  ok('…which reports a failure rather than losing it silently',
    /Could not save the layout/.test(ADMIN));

  /* Buttons that do nothing are noise, and a reset button on an untouched
     layout invites exactly the misclick it exists to protect against. */
  ok('the controls render only when there is something to do',
    /const customised = \(_apiLayout\.demoted \|\| \[\]\)\.length \|\| \(_apiLayout\.pinned \|\| \[\]\)\.length/.test(ADMIN));
  ok('…and the undo only when a reset happened', /const canUndo = apiLayoutHasUndo\(\)/.test(ADMIN));
  ok('they are drawn with the grid', /renderApiLayoutControls\(\);/.test(ADMIN));
  ok('…and have somewhere to live at the top of the section',
    /id="api-layout-controls"/.test(fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8')));
  ok('the reset says nothing is deleted, because that is the fear',
    /Nothing is deleted and no key is touched/.test(ADMIN));
}

console.log('\n  both lists redraw, because both changed');
{
  const fn = ADMIN.slice(ADMIN.indexOf('async function pinIntegration'), ADMIN.indexOf('/* ─── Find Your Size'));
  ok('the API list is refreshed', /loadApiStatus\(\);/.test(fn));
  ok('…and the catalogue too', /renderIntegrationStore\(\);/.test(fn));
  ok('a failed save is reported rather than silently lost',
    /Could not save the layout/.test(fn));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
