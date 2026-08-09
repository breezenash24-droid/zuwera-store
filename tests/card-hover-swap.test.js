/* Second-image hover swap: the alt-image picker on both grids, the three-state
   override resolver, the cascade claim the CSS depends on, and the wiring. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  \u2014 ' + e : '')); } };

/* Pull a named function out of a file and evaluate just that. */
function extract(file, name, extraGlobals) {
  const s = fs.readFileSync(R + file, 'utf8');
  const start = s.indexOf('function ' + name + '(') > -1
    ? s.indexOf('function ' + name + '(')
    : s.indexOf(name + ' = function');
  if (start < 0) throw new Error('not found: ' + name + ' in ' + file);
  let i = s.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  const body = s.slice(start, end).replace(/^window\./, '').replace(new RegExp('^' + name + ' = function'), 'function ' + name);
  const names = Object.keys(extraGlobals || {});
  return new Function(...names, body + '; return ' + name + ';')(...names.map(n => extraGlobals[n]));
}

const win = {};
const altImage = extract('storefront.js', '__zwCardAltImage', { window: win });
const hoverOn = extract('drop001.html', 'zwCardHoverOn', { window: win });

console.log('\n  hover swap\n');

/* ── which photo the card swaps to ───────────────────────────────────────── */
console.log('  picking the alt photo (homepage grid)');
{
  const p = (rows) => ({ product_images: rows });
  ok('takes the second photo',
    altImage(p([{ image_url: 'a.jpg', sort_order: 0 }, { image_url: 'b.jpg', sort_order: 1 }]), 'a.jpg') === 'b.jpg');
  ok('respects sort_order, not array order',
    altImage(p([{ image_url: 'z.jpg', sort_order: 5 }, { image_url: 'a.jpg', sort_order: 0 }, { image_url: 'b.jpg', sort_order: 1 }]), 'a.jpg') === 'b.jpg');
  ok('one photo → nothing to swap to',
    altImage(p([{ image_url: 'a.jpg', sort_order: 0 }]), 'a.jpg') === '');
  ok('no photos → nothing to swap to', altImage(p([]), '') === '');
  ok('never swaps a photo for itself',
    altImage(p([{ image_url: 'a.jpg', sort_order: 0 }, { image_url: 'a.jpg', sort_order: 1 }]), 'a.jpg') === '');
  ok('skips a video by media_type',
    altImage(p([{ image_url: 'a.jpg', sort_order: 0 }, { image_url: 'clip.webm', sort_order: 1, media_type: 'video' }, { image_url: 'b.jpg', sort_order: 2 }]), 'a.jpg') === 'b.jpg');
  ok('skips a video by extension',
    altImage(p([{ image_url: 'a.jpg', sort_order: 0 }, { image_url: 'clip.mp4?x=1', sort_order: 1 }, { image_url: 'b.jpg', sort_order: 2 }]), 'a.jpg') === 'b.jpg');
  ok('video-only second slot → nothing to swap to',
    altImage(p([{ image_url: 'a.jpg', sort_order: 0 }, { image_url: 'clip.mov', sort_order: 1 }]), 'a.jpg') === '');
  ok('tolerates a blank row',
    altImage(p([{ image_url: 'a.jpg', sort_order: 0 }, { image_url: '', sort_order: 1 }, { image_url: 'b.jpg', sort_order: 2 }]), 'a.jpg') === 'b.jpg');
}

/* ── store default vs per-collection override ────────────────────────────── */
console.log('\n  the toggle');
{
  const set = (global, override) => {
    win.__zwCardHoverSwap = global;
    win.__zwCollPageCfg = override === undefined ? null : { card_hover: override };
  };
  set(false, undefined); ok('off by default', hoverOn() === false);
  set(true, undefined); ok('store setting on → on', hoverOn() === true);
  set(true, ''); ok('builder left on "use store default" → follows the store (on)', hoverOn() === true);
  set(false, ''); ok('…and follows it when off too', hoverOn() === false);
  set(false, 'on'); ok('builder can turn it ON for one collection', hoverOn() === true);
  set(true, 'off'); ok('builder can turn it OFF for one collection', hoverOn() === false);
  set(true, 'nonsense'); ok('a junk override falls back to the store setting', hoverOn() === true);
}

/* ── the cascade the fade depends on ─────────────────────────────────────── */
console.log('\n  cascade');
{
  // Specificity of the two competing rules. :is() counts as its most specific
  // argument (Selectors L4).
  function spec(sel) {
    let a = 0, b = 0, c = 0;
    sel = sel.replace(/:is\(([^)]*)\)/g, (m, args) => {
      const best = args.split(',').map(s => s.trim())
        .map(s => (s.startsWith('#') ? [1, 0, 0] : s.startsWith('.') || s.startsWith(':') ? [0, 1, 0] : [0, 0, 1]))
        .sort((x, y) => (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]))[0];
      a += best[0]; b += best[1]; c += best[2];
      return ' ';
    });
    sel.split(/[\s>+~]+/).filter(Boolean).forEach(part => {
      (part.match(/#[\w-]+/g) || []).forEach(() => a++);
      (part.match(/\.[\w-]+|:[\w-]+/g) || []).forEach(() => b++);
      const tag = part.replace(/[#.:][\w-]+/g, '');
      if (tag && /^[a-z]+$/i.test(tag)) c++;
    });
    return [a, b, c];
  }
  const existing = spec(':is(.pcard-img,.product-img) img');           // sets transition:transform
  const mine = spec(':is(.pcard-img,.product-img) > :is(.pcard-img-alt,.product-img-alt)');
  const wins = (mine[0] - existing[0]) || (mine[1] - existing[1]) || (mine[2] - existing[2]);
  ok('the alt-image rule outranks the existing `img` transition rule ('
    + mine.join(',') + ' > ' + existing.join(',') + '), so the fade is not dropped', wins > 0);

  const flat = spec('.pcard-img-alt');
  const flatWins = (flat[0] - existing[0]) || (flat[1] - existing[1]) || (flat[2] - existing[2]);
  ok('…and a flat .pcard-img-alt would have LOST (' + flat.join(',') + '), which is why the child selector is there', flatWins < 0);

  const css = fs.readFileSync(R + 'storefront-cohesion.css', 'utf8');
  ok('the rule in the file is the child form, not the flat one',
    /:is\(\.pcard-img,\.product-img\) > :is\(\.pcard-img-alt,\.product-img-alt\)/.test(css));
  ok('the reveal is behind @media (hover:hover), so touch cannot latch it',
    /@media \(hover:hover\) and \(pointer:fine\)\{[\s\S]{0,400}?zw-card-hover/.test(css));
  ok('the alt image does not eat clicks meant for the card', /pointer-events:none/.test(
    css.slice(css.indexOf('Second-image hover swap'), css.indexOf('Second-image hover swap') + 1200)));
  ok('reduced motion is honoured', /prefers-reduced-motion[\s\S]{0,200}pcard-img-alt/.test(css));
}

/* ── wiring across both grids ────────────────────────────────────────────── */
console.log('\n  wiring');
{
  const home = fs.readFileSync(R + 'storefront.js', 'utf8');
  const coll = fs.readFileSync(R + 'drop001.html', 'utf8');
  const admin = fs.readFileSync(R + 'admin.html', 'utf8');
  const adminJs = fs.readFileSync(R + 'admin-main.js', 'utf8');
  const builder = fs.readFileSync(R + 'builder.html', 'utf8');

  ok('homepage grid renders the alt image', /class="pcard-img-alt"/.test(home));
  ok('collection grid renders the alt image', /class="product-img-alt"/.test(coll));
  ok('both grids define the body-class helper',
    /__zwApplyCardHover = function/.test(home) && /__zwApplyCardHover = function/.test(coll));
  ok('both read the cached value before first paint',
    (home.match(/zw_card_hover/g) || []).length >= 2 && (coll.match(/zw_card_hover/g) || []).length >= 2);
  ok('both apply the saved setting, with its timing', /__zwApplyCardHover\(!!\(cta && cta\.card_hover\), cta && cta\.card_hover_ms\)/.test(home)
    && /__zwApplyCardHover\(zwCardHoverOn\(\), window\.__zwCardHoverMsCfg\)/.test(coll));
  ok('the carousel card slides instead of cross-fading', /bindCardHoverSwap/.test(coll));
  ok('…and only rewinds a card still where it put it', /!== 1\) return;/.test(coll));

  ok('admin has the toggle', /id="settCardHover"/.test(admin));
  ok('admin loads it', /settCardHover'\)[\s\S]{0,80}checked = !!\(v && v\.card_hover\)/.test(adminJs));
  ok('admin saves it', /card_hover, card_hover_ms \}/.test(adminJs) && /const card_hover =/.test(adminJs));

  /* ── instant by default, timing configurable ────────────────────────────── */
  const cohesion = fs.readFileSync(R + 'storefront-cohesion.css', 'utf8');
  ok('the swap is instant unless a fade is configured',
    /transition:opacity var\(--zw-card-hover-ms, 0ms\) ease/.test(cohesion));
  ok('admin offers a speed control with instant as the default',
    /id="settCardHoverMs"/.test(admin) && /value="0">Instant \(default\)/.test(admin));
  ok('the carousel card honours the same timing',
    /__zwCardHoverMs \|\| 0\) > 0/.test(coll) && /smooth \? 'smooth' : 'auto'/.test(coll));
  ok('the timing var is set on documentElement, before body exists',
    /documentElement\.style\.setProperty\('--zw-card-hover-ms'/.test(home));

  /* ── the alt image cannot be laid out beside the cover shot ─────────────── */
  const INLINE = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0';
  ok('homepage alt image carries its positioning inline',
    home.includes('class="pcard-img-alt"') && home.includes(INLINE));
  ok('collection alt image carries its positioning inline',
    coll.includes('class="product-img-alt"') && coll.includes(INLINE));
  ok('the hover reveal outranks that inline opacity',
    /opacity:1 !important/.test(cohesion.slice(cohesion.indexOf('Second-image hover swap'))));

  /* ── the minifier can no longer mangle the reduced-motion values ────────── */
  {
    const CleanCSS = require('clean-css');
    let mangled = 0, zeroed = 0;
    ['storefront-cohesion.css', 'product.css'].forEach(f => {
      const out = new CleanCSS({ level: 2 }).minify(fs.readFileSync(R + f, 'utf8')).styles;
      mangled += (out.match(/NaN/g) || []).length;
      zeroed += (out.match(/(?:animation|transition)-duration:0s/g) || []).length;
    });
    ok('no NaN values survive minification', mangled === 0, mangled + ' found');
    ok('no reduced-motion duration collapses to a real 0s (which fires no transitionend)',
      zeroed === 0, zeroed + ' found');
    ok('no .01ms left anywhere to be mangled again',
      !/[\s:]0?\.01ms/.test(fs.readFileSync(R + 'storefront-cohesion.css', 'utf8')
        + fs.readFileSync(R + 'product.css', 'utf8')
        + fs.readFileSync(R + 'builder.html', 'utf8')));
  }
  ok('the audit entry records it', /logAdminAudit\('settings\.update', 'site_settings', 'product_card_cta', \{[^}]*card_hover/.test(adminJs));
  ok('builder offers a three-state per-collection override',
    /'card_hover'[\s\S]{0,120}Use store default/.test(builder));
  ok('builder default is "use store default"', /card_hover:''/.test(builder));

  // The body class name has to be spelled the same in all four places.
  const names = new Set();
  [home, coll].forEach(s => (s.match(/zw-card-hover/g) || []).forEach(m => names.add(m)));
  const cssHits = (fs.readFileSync(R + 'storefront-cohesion.css', 'utf8').match(/zw-card-hover/g) || []).length;
  ok('the body class is spelled identically in the JS and the CSS', names.size === 1 && cssHits >= 1,
    [...names].join('/') + ' / css hits ' + cssHits);
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
