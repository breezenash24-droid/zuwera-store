/* The quick-add modal's photo strip.

   The bug this guards: the slot had width:100%, aspect-ratio:4/5 AND
   max-height:min(72vh,640px) all at once. Those three cannot hold together — a
   728px pane at 4/5 wants 910px of height and the cap allows 640 — so the box
   resolved to 512x640 and object-fit:cover cropped a portrait photo to fit,
   which is what "cutting off some of the images" was. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  \u2014 ' + e : '')); } };

const css = fs.readFileSync(R + 'drop001.html', 'utf8');

/** Every declaration block that targets a strip item, at any breakpoint. */
function stripItemRules() {
  const out = [];
  const re = /\.collection-product-gallery\[data-layout="dual"\][^{]*\.zw-strip\s*>\s*\*\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out;
}
function decl(block, prop) {
  const m = block.match(new RegExp('(?:^|[;{\\s])' + prop + '\\s*:\\s*([^;}]+)'));
  return m ? m[1].trim() : null;
}

console.log('\n  quick-add modal photo strip\n');

const rules = stripItemRules();
ok('found the strip-item rules', rules.length >= 2, rules.length + ' found');

/* ── the over-constraint must not come back ──────────────────────────────── */
rules.forEach((block, i) => {
  const ar = decl(block, 'aspect-ratio');
  const h = decl(block, 'height');
  const mh = decl(block, 'max-height');
  const hasRatio = ar && ar !== 'auto';
  const hasHeightCap = (h && h !== 'auto') || (mh && mh !== 'none');
  ok('rule ' + (i + 1) + ': does not set both a fixed ratio and a height'
    + (hasRatio ? ' [ratio ' + ar + ']' : '') + (hasHeightCap ? ' [height ' + (h || mh) + ']' : ''),
    !(hasRatio && hasHeightCap),
    'aspect-ratio:' + ar + ' height:' + h + ' max-height:' + mh);
});

/* ── and the modal does not rely on any of it ────────────────────────────── */
{
  /* Everything below asserts the STYLESHEET, and the stylesheet was right the
     whole time — one photo per view, contained, a definite height, all of it in
     the served CSS, valid, outside any media query, uncontested by the nine
     stylesheets that page loads. The modal still rendered two photos at half
     width each, and it was reported three times.

     A rule scoped four classes deep through an attribute the caller writes has
     a lot of ways not to match. So the strip now says how many photos are in
     view ON THE ELEMENTS, and this rule is the second voice rather than the
     only one. If it ever drifts from perView, the two disagree in a way that is
     visible rather than silent — which is what these assertions are for. */
  ok('the modal asks for one photo per view in its own right',
    /perView: 1,/.test(css),
    'the stylesheet below says the same thing and was not reaching the photos');
}

/* ── nothing is cropped ──────────────────────────────────────────────────── */
{
  const base = rules[0] || '';
  ok('the whole photo is shown (object-fit:contain), not cropped to fill',
    decl(base, 'object-fit') === 'contain', decl(base, 'object-fit'));
  ok('one photo per view (flex basis 100%)', /flex:\s*0\s+0\s+100%/.test(base));
  ok('the slot has a definite height so the pane cannot stretch it',
    (decl(base, 'height') || '').indexOf('min(') === 0, decl(base, 'height'));
  ok('the phone rule overrides height, not max-height (a cap would re-create the conflict)',
    rules.length > 1 && decl(rules[1], 'height') !== null && decl(rules[1], 'max-height') === null,
    'height:' + decl(rules[1] || '', 'height') + ' max-height:' + decl(rules[1] || '', 'max-height'));
}

/* ── the arithmetic, spelled out ─────────────────────────────────────────── */
{
  // What the OLD rule produced, and what the new one does, for a real modal.
  const paneW = 728;                       // media pane in a 1348px modal
  const oldCap = 640;                      // min(72vh, 640px) at a ~1000px viewport
  const oldWanted = paneW * 1.25;          // width:100% at aspect-ratio 4/5
  ok('old rule was over-constrained: 4/5 wanted ' + oldWanted + 'px of height, the cap allowed ' + oldCap,
    oldWanted > oldCap);

  // An over-constrained box resolves one of two ways, and the old rule was
  // broken under BOTH — which is why the screenshot showed a hard crop AND part
  // of the neighbouring photo at the same time.
  function coverVisible(bw, bh, pw, ph) {
    const s = Math.max(bw / pw, bh / ph);
    return { w: bw / (pw * s), h: bh / (ph * s) };
  }
  //   (a) height capped, width kept at 100% → a landscape box for a portrait shot
  const a = coverVisible(paneW, oldCap, 1000, 1250);
  ok('capped-height resolution: cover showed only ' + Math.round(a.h * 100) + '% of a portrait photo',
    a.h < 0.95, Math.round(a.h * 100) + '%');
  //   (b) ratio honoured, width shrunk to 512 → the slot stops filling the pane,
  //       so the next photo shows beside it, and any shot that ISN'T 4/5 crops.
  const b = coverVisible(oldCap * 0.8, oldCap, 1000, 1000);
  ok('shrunk-width resolution: the slot covered only ' + Math.round((oldCap * 0.8 / paneW) * 100)
    + '% of the pane, so the next photo showed beside it', (oldCap * 0.8) < paneW);
  ok('…and a square photo still lost ' + Math.round((1 - b.w) * 100) + '% of its width to cover',
    b.w < 0.95, Math.round(b.w * 100) + '%');

  // contain on the new box: the whole photo, every time, whatever its ratio.
  const newH = 760;
  [[1000, 1250], [1000, 1000], [1200, 800], [800, 1600]].forEach(([w, h]) => {
    const s = Math.min(paneW / w, newH / h);
    const shownH = h * s, shownW = w * s;
    ok('contain shows all of a ' + w + 'x' + h + ' photo (' + Math.round(shownW) + 'x' + Math.round(shownH) + ' in a ' + paneW + 'x' + newH + ' slot)',
      shownH <= newH + 0.5 && shownW <= paneW + 0.5);
  });
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
