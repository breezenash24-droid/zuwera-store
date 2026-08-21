/* Mirror the whole header arrangement left-to-right, as a modifier rather than
   as eleven more entries in the gallery.
   ═══════════════════════════════════════════════════════════════════════════

   ── WHY A MODIFIER AND NOT MORE TILES ───────────────────────────────────────

   Of the eleven shipped arrangements, only four have their mirror in the
   catalogue already — classic/logo-right and logo-center/actions-left are each
   other's. The other seven have none:

       links-left      left/left/right       -> right/right/left    absent
       logo-beside     center/center/right   -> center/center/left  absent
       stacked         center/center/right·2 -> center/center/left·2 absent
       links-row       left/left/right·2     -> right/right/left·2  absent
       all-left        left/left/left        -> right/right/right   absent
       minimal         left/none/right       -> right/none/left     absent
       minimal-center  center/none/right     -> center/none/left    absent

   So this roughly doubles what the gallery can express, and it keeps doing that
   for any arrangement added later without anyone remembering to write its twin.

   The four that DO have named twins are the proof the operation is right rather
   than approximately right: flipping one has to land exactly on the other.

   ── AND WHY THE MIRROR IS DEFINED TWICE ─────────────────────────────────────

   functions/_middleware.js stamps the arrangement into the HTML as it is
   served, and a Worker cannot import a browser file. That is the same reason it
   already keeps its own copy of SPOTS. Both definitions are checked here
   against every shipped layout, so they cannot drift.

   scripts/stamp-header-layout.js does NOT get a third copy — it already loads
   the layout table, so it calls the same mirror(). */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* Load the real layout table the way the builder does. */
const L = (() => {
  const src = read('header-layouts.js');
  const win = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  const doc = {
    documentElement: { getAttribute: () => null, setAttribute() {}, classList: { toggle() {} }, style: {} },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    readyState: 'complete', createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
  };
  win.document = doc;
  win.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  win.location = { pathname: '/', search: '' };
  new Function('window', 'document', 'localStorage', 'location', src)(win, doc, win.localStorage, win.location);
  return win.ZWHeaderLayouts;
})();

const MID = read('functions/_middleware.js');
const HL = read('header-layouts.js');
const B = read('builder.html');

console.log('\n  the header can be mirrored\n');

console.log('  the operation itself');
{
  ok('the layout table exposes a mirror', typeof L.mirror === 'function');
  ok('left and right swap',
    L.mirror({ logo: 'left', links: 'left', actions: 'right' }).logo === 'right'
    && L.mirror({ logo: 'left', links: 'left', actions: 'right' }).actions === 'left');
  ok('centre is its own mirror', L.mirror({ logo: 'center' }).logo === 'center');
  /* `none` is not a side — the categories are in the menu drawer — so mirroring
     must not turn it into one. */
  ok('“none” is left alone, because it is not a position',
    L.mirror({ links: 'none' }).links === 'none');
  ok('the row count is not a side either',
    L.mirror({ logo: 'left', linksRow: 2 }).linksRow === 2);
  ok('mirroring twice is the identity, on every shipped layout',
    L.list.every((l) => JSON.stringify(L.mirror(L.mirror(l.spec))) === JSON.stringify(l.spec)));
  ok('…and it does not mutate what it was given',
    (() => { const s = { logo: 'left', links: 'center', actions: 'right', linksRow: 1 };
      L.mirror(s); return s.logo === 'left'; })());
}

console.log('\n  the four arrangements that already have a named twin');
{
  /* If flipping one does not land exactly on the other, the mirror is not the
     operation the gallery already describes in words. */
  const TWINS = [['classic', 'logo-right'], ['logo-center', 'actions-left']];
  for (const [a, b] of TWINS) {
    const A = L.byId(a), Bl = L.byId(b);
    ok(a + ' mirrored is exactly ' + b,
      JSON.stringify(L.mirror(A.spec)) === JSON.stringify(Bl.spec),
      JSON.stringify(L.mirror(A.spec)) + ' vs ' + JSON.stringify(Bl.spec));
    ok('…and ' + b + ' mirrored is exactly ' + a,
      JSON.stringify(L.mirror(Bl.spec)) === JSON.stringify(A.spec));
  }
  const named = new Set(L.list.map((l) => JSON.stringify(l.spec)));
  const newOnes = L.list.filter((l) => !named.has(JSON.stringify(L.mirror(l.spec))));
  ok(newOnes.length + ' arrangements gain a mirror the gallery did not have',
    newOnes.length >= 7, newOnes.map((l) => l.id).join(', '));
}

console.log('\n  two arrangements cannot be mirrored, and the switch says so');
{
  /* Found by running conflict() over every mirrored spec rather than assuming
     the operation was total. `left` may hold two parts — only the first takes
     the leading margin, so they sit in document order — but `right` is
     margin-left:auto, and a second part claiming the same margin splits the
     free space and pushes the pair APART. So the mirror of anything with two
     parts on the left is an arrangement the stylesheet cannot build:

         links-left   logo+links left  ->  logo+links right
         all-left     all three left   ->  all three right

     Nine of eleven mirror cleanly. Rather than a switch that quietly does
     nothing on those two, the builder turns it off with the reason on it.

     Making the right zone group would mean giving only the leading part the
     auto margin and assigning explicit orders to the rest, across five nav
     dialects — placement surgery, not a toggle. That is the work if these two
     mirrors are ever wanted. */
  const blocked = L.list.filter((l) => !L.mirrorable(l.id)).map((l) => l.id).sort();
  ok('exactly the two with a pair on the left are blocked',
    JSON.stringify(blocked) === JSON.stringify(['all-left', 'links-left']),
    blocked.join(', '));
  ok('…and every other arrangement mirrors into one the header can hold',
    L.list.filter((l) => L.mirrorable(l.id)).length === L.list.length - 2);
  ok('the reason is a sentence the modal can show, not a boolean',
    /two parts on the right/.test(L.mirrorBlocked('links-left')),
    L.mirrorBlocked('links-left'));
  ok('…and it is empty for the ones that can', L.mirrorBlocked('classic') === '');

  ok('the builder refuses the click rather than accepting it',
    /const why=_L\.mirrorBlocked\(_sel\);/.test(B) && /cannot be mirrored/.test(B));
  ok('…and disables the control with the reason on it',
    /on\.disabled=!!why;/.test(B) && /on\.title=why\?/.test(B));
  ok('…repainted when the selection changes, not only when the modal opens',
    /function pickHeaderLayout\(id\)\{[\s\S]{0,460}paintHdrFlip\(\)/.test(B));
}

console.log('\n  it travels with the other extras rather than as a special case');
{
  ok('flip is an extra key', /EXTRA_KEYS = \['lines', 'account', 'iconLabels', 'order', 'flip'(,|\])/.test(HL));
  ok('…validated to on/off like the rest', /flip:\s*\{ on: 1, off: 1 \}/.test(HL));
  ok('apply() mirrors when it is on',
    /if \(spec && e\.flip === 'on'\) spec = mirror\(spec\);/.test(code(HL)));
  ok('the tiles are drawn mirrored too',
    /function miniature\(layout, device, flip\)/.test(HL)
    && /zones\(flip \? mirror\(l\.spec\) : l\.spec\)/.test(code(HL)),
    'a gallery that drew unflipped tiles beside a mirrored preview is the tiles-that-lie problem again');
}

console.log('\n  and it reaches the first frame, not just the second');
{
  /* Three writers put the arrangement on <html>, and all three have to agree or
     the header draws one way and then swaps. */
  ok('the edge stamps it mirrored', /value\.flip === 'on'\) \? mirrorSpec\(raw\) : raw/.test(code(MID)));
  ok('…with its own copy of the operation, because a Worker cannot import one',
    /const MIRROR = \{ left: 'right', right: 'left', center: 'center', none: 'none' \};/.test(MID));
  ok('the build-time stamp uses the layout table’s mirror, not a third copy',
    /L\.mirror\(layout\.spec\)/.test(code(read('scripts/stamp-header-layout.js'))));
  /* The pre-paint block stamps the cached tuple straight onto <html>, so the
     tuple has to hold the arrangement as it will LOOK. */
  ok('the visitor cache stores the mirrored spec, not the flag beside the raw one',
    /var cs = \(l && extras\(opts\)\.flip === 'on'\) \? mirror\(l\.spec\) : \(l && l\.spec\);/.test(code(HL)),
    'otherwise the first frame draws unmirrored and then swaps');
  ok('…and carries flip in the tuple, appended so an old cache still reads',
    /ATTR_FIELDS = \['lines', 'account', 'iconLabels', 'order', 'flip'(,|\])/.test(HL));
}

console.log('\n  the two definitions of the mirror agree, on every shipped layout');
{
  /* Lift the Worker's mirror out of the Worker and run it against the layout
     table's. This is the same arrangement the codebase already makes for
     headerBottom() across two files that cannot share a module. */
  const m = MID.match(/const MIRROR = \{[^}]*\};\s*function mirrorSpec\(s\) \{[\s\S]*?\n\}/);
  ok('the Worker’s copy can be read out for comparison', !!m);
  if (m) {
    const workerMirror = new Function('return (function(){ ' + m[0] + ' return mirrorSpec; })()')();
    const differ = L.list.filter((l) =>
      JSON.stringify(workerMirror(l.spec)) !== JSON.stringify(L.mirror(l.spec)));
    ok('they produce the same arrangement for all ' + L.list.length,
      differ.length === 0,
      differ.map((l) => l.id + ': worker ' + JSON.stringify(workerMirror(l.spec))
        + ' vs table ' + JSON.stringify(L.mirror(l.spec))).join(' | '));
  }
}

console.log('\n  the four placement attributes could not describe a mirror, and now five do');
{
  /* Reported as "some of the header mirrored work, while some didn't at all",
     and measuring every arrangement's geometry on the live page found exactly
     two. At 1280px, part centres, normal -> mirrored, against the reflection:

         logo-beside   logo  512 -> 512   wanted 768      frozen
                       links 681 -> 681   wanted 599      frozen
         stacked       actions 1153.6 -> 1153.6  wanted 126.4   frozen

     Both are combinations the catalogue never contained, so no rule covered
     them:

       a CENTRED PAIR reads [logo][categories] or [categories][logo], and both
       are logo=center links=center — the four attributes cannot tell them
       apart, so the pair drew the same way round either way;

       the two-row centred rule pins the actions with a literal `right:`, which
       outranks data-zw-hdr-actions entirely.

     So the fact "this arrangement is mirrored" is written down instead of
     inferred from the other four. After the fix, measured the same way: all
     nine reflect, logo-beside 512 -> 768 and 681 -> 599, stacked 1153.6 ->
     126.4. */
  const CSS = read('storefront-cohesion.css');
  const TE = read('theme-engine.js');
  const STAMP = read('scripts/stamp-header-layout.js');

  ok('theme-engine writes the fifth attribute',
    /if \(spec\.flip === 'on'\) root\.setAttribute\('data-zw-hdr-flip', 'on'\);/.test(code(TE)));
  ok('…and removes it when the mirror is turned off',
    /else root\.removeAttribute\('data-zw-hdr-flip'\);/.test(code(TE)),
    'left behind, a store that unmirrored would stay mirrored');
  ok('…and clear() takes it with the others',
    /'data-zw-hdr-linksrow', 'data-zw-hdr-flip'(,|\])/.test(TE));

  ok('the edge stamps it too', /out\['data-zw-hdr-flip'\] = 'on';/.test(code(MID)));
  ok('the build stamp writes it', /if \(flipped\) keep \+= ' data-zw-hdr-flip="on"';/.test(code(STAMP)));
  ok('…reads it off the row, or it could never bake one',
    /flip: pick\('flip', \['on', 'off'\]\)/.test(code(STAMP)),
    'a field fetchLayout does not pick up is a field that is always absent');
  ok('…counts it as an answer worth baking on its own',
    /chosen\.order \|\| chosen\.flip\b/.test(code(STAMP)));
  ok('…and strips it, so turning the mirror off actually un-mirrors',
    /'data-zw-hdr-flip'(,|\])/.test(STAMP));

  ok('the centred pair swaps sides when mirrored',
    /html\[data-zw-hdr-flip="on"\]\[data-zw-hdr-logo="center"\]\[data-zw-hdr-links="center"\]\[data-zw-hdr-linksrow="1"\]/.test(CSS));
  ok('…by negating the same two offsets, not by inventing new arithmetic',
    /data-zw-hdr-flip="on"[\s\S]{0,400}left: calc\(\(var\(--zw-hdr-links-w/.test(CSS));
  ok('the two-row centred actions pin to the other side',
    /html\[data-zw-hdr-flip="on"\]\[data-zw-hdr-linksrow="2"\]\[data-zw-hdr-logo="center"\]/.test(CSS));
  ok('…clearing the literal `right:` it is overriding',
    /left: var\(--zw-mobile-gutter, 2\.5rem\); right: auto;/.test(CSS),
    'an absolutely positioned box with both set stretches between them');
}

console.log('\n  and the builder can actually turn it on');
{
  ok('there is a control', /id="hdrFlipOn"/.test(B) && /id="hdrFlipOff"/.test(B));
  ok('…which says what it does', /Flip the whole arrangement left to right/.test(B));
  ok('it applies on click, like the lines toggle beside it',
    /function setHdrFlip\(v\)\{[\s\S]{0,900}sendChrome\(\)/.test(B));
  ok('…and repaints the gallery so the tiles show it',
    /function setHdrFlip\(v\)\{[\s\S]{0,940}paintHeaderCfg\(\)/.test(B));
  ok('the draft carries it', /if \(chromeHdrFlip\) out\.flip = chromeHdrFlip;/.test(B));
  ok('the preview push carries it', /flip:chromeHdrFlip/.test(B));
  ok('Cancel puts it back', /chromeHdrFlip=hdrCfgWas\.flip/.test(B));
  ok('…and it is loaded from the saved row', /chromeHdrFlip=one\('flip',\['on','off'\]\)/.test(B));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
