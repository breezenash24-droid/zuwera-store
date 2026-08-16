#!/usr/bin/env node
/**
 * tokenize-cascade.js — the literals a regex cannot safely touch.
 *
 *   node scripts/tokenize-cascade.js            report, change nothing
 *   node scripts/tokenize-cascade.js --write    convert the safe ones
 *
 * ── Why a second tool ────────────────────────────────────────────────────────
 *
 * tokenize-colors.js converts a literal when the literal ITSELF says what it
 * means: rgba(244,241,235,α) inside a dark rule is the foreground at α, and
 * var(--cαα) is the same colour. Nothing else has to be true for that to hold.
 *
 * The literals left over are not like that. What they mean depends on rules
 * somewhere else in the file:
 *
 *     body.light-mode      #cart-modal { background: #F0EEE9 }
 *     body.super-light-mode #cart-modal { background: #FFFFFF }
 *
 * Both are var(--ink) — --ink is #F0EEE9 in light and #FFFFFF in super-light —
 * so converting both changes nothing and makes the pair follow any theme. But
 * take the FIRST one on its own, with no super-light partner, and it is not
 * var(--ink): a body.light-mode rule also applies in super-light (super-light
 * carries both classes), so today it paints cream on the white page and
 * var(--ink) would paint white. Same literal, same property, same file —
 * convertible or not depending on whether a rule twenty lines down exists.
 *
 * That is why the first tool stopped here, and it was right to.
 *
 * ── The rule this one holds to ───────────────────────────────────────────────
 *
 * A declaration is converted only when the colour it RESOLVES TO is unchanged
 * in all three built-in themes. Not "close enough", not "probably fine": the
 * cascade is walked per mode (dark → light → super-light, each falling back to
 * the one before), both the literal and the proposed token are resolved against
 * the real token values read out of base.css, and the largest channel
 * difference across the three must be at or under TOLERANCE.
 *
 * Everything else is REPORTED, not converted, because everything else is a
 * design decision wearing a refactor's clothes:
 *
 *   Four different near-blacks are used as lifted surfaces — #0f0f0f, #111,
 *   #1a1a1a, #1b1b1d. Mapping them all to --surface would make a new theme
 *   reach them and would also flatten a hierarchy somebody built on purpose.
 *   That is a decision for a person.
 *
 *   #E8E3DC is a cream that is nobody's token, four shades off --ink. Snapping
 *   it is a visible change to a colour someone chose.
 *
 *   Shadows and photo scrims stay literal for good: rgba(0,0,0,.45) under a
 *   modal is a shadow, and a shadow that follows the foreground becomes a white
 *   glow on a dark theme, which inverts what the rule means.
 */

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

/* One channel in 255. The previous pass measured 1.00 and that was already
   invisible; anything a person can actually see must be a decision, not a
   side-effect of tidying. */
const TOLERANCE = 2;

/* The storefront's stylesheets AND the <style> blocks inside its pages.
 *
 * The first version of this list was .css only, which quietly left 533 literals
 * unexamined — more than were in the stylesheets. product.html alone carries 93.
 * A page's inline <style> is the same cascade as a linked one; there was no
 * reason for it to be exempt beyond my having forgotten it existed.
 *
 * Deliberately NOT here: admin.html, builder.html, analytics.html,
 * diagnostic.html. They are the shop's back office, with their own palette and
 * their own dark mode, and wiring them to storefront tokens would repaint the
 * admin because a customer-facing theme changed. */
const FILES = ['storefront-cohesion.css', 'cart.css', 'nav.css', 'product.css',
  'reviews.css', 'reviews-vibe.css', 'email-popup.css', 'storefront-mobile-rebuild.css',
  'base.css',
  'index.html', 'product.html', 'drop001.html', 'bag.html', 'checkout.html',
  'account.html', 'returns.html', 'landing.html', 'policies.html', 'journal.html',
  'about.html', 'confirm.html', 'sizeguide.html', '404.html'];

/* An HTML page is treated as the concatenation of its <style> blocks — one
   cascade, which is what the browser sees — while edits are written back at the
   real offsets in the file. Anything outside a <style> block is invisible to
   this tool, which is what keeps it out of the JS. */
function styleSegments(src, file) {
  if (!/\.html$/i.test(file)) return [{ at: 0, text: src }];
  const segs = [];
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    segs.push({ at: m.index + m[0].indexOf('>') + 1, text: m[1] });
  }
  return segs;
}

const MODES = ['dark', 'light', 'super-light'];

/* Read the palette out of base.css rather than restating it — the whole point
   of the exercise is that these are declared in one place. */
function palette() {
  /* Comments blanked FIRST. base.css explains the ladder in prose that contains
     `body.light-mode { --fg-rgb: … }`, and slicing a block to the next `}`
     without doing this stops at a brace inside the explanation — which read the
     comment as the declaration and produced a palette of nonsense. The same
     trap as before, in the tool built to fix its consequences. */
  const css = fs.readFileSync(path.join(root, 'base.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const block = (sel) => {
    /* Anchored: `body {` must not match `body.light-mode {`. */
    const re = new RegExp('(^|[}\\s])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm');
    const m = re.exec(css);
    if (!m) return '';
    let i = m.index + m[0].length, depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    return css.slice(m.index, i);
  };
  const grab = (src, name) => {
    const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(src);
    return m ? m[1].trim() : null;
  };
  const root_ = block(':root'), light = block('body.light-mode'), sup = block('body.super-light-mode');
  const pick = (name) => ({
    dark: grab(root_, name) || grab(block('body'), name),
    light: grab(light, name) || grab(root_, name) || grab(block('body'), name),
    'super-light': grab(sup, name) || grab(light, name) || grab(root_, name) || grab(block('body'), name),
  });
  /* The named roles from storefront-cohesion.css. Constant across the three
     built-in modes — they are declared once in :root — but NOT constant across
     themes any more: theme-engine.js sets all four from a theme's own tokens.
     That is exactly what makes them worth converting to, and it is why leaving
     them out of this list the first time made the tool report a pile of free
     conversions as "a real colour choice, 19/255 away". They were 0 away. */
  const coh = fs.readFileSync(path.join(root, 'storefront-cohesion.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const flat = (name) => {
    const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(coh);
    if (!m) return null;
    const v = m[1].trim();
    return { dark: v, light: v, 'super-light': v };
  };
  return {
    '--fg-rgb': pick('fg-rgb'), '--bg-rgb': pick('bg-rgb'),
    '--ink': pick('ink'), '--paper': pick('paper'),
    '--black': pick('black'), '--white': pick('white'),
    '--zw-theme-surface': pick('zw-theme-surface'),
    '--zw-cream': flat('zw-cream'),
    '--zw-surface': flat('zw-surface'),
    '--zw-fg-hover': flat('zw-fg-hover'),
    '--zw-accent': flat('zw-accent'),
  };
}
const PAL = palette();

// ── Colour maths ────────────────────────────────────────────────────────────

function parseColor(v) {
  v = String(v).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16)).concat(1);
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1
      : String(m[4]).endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  return null;
}

/** Resolve a value that may contain our tokens, in one mode.
 *  Recurses, because base.css defines some aliases in terms of others —
 *  `--paper: rgb(var(--fg-rgb))` in light mode — and a resolver that stops at
 *  the first hop returns null and quietly rules that token out of every
 *  comparison. */
function resolve(value, mode, depth) {
  if ((depth || 0) > 4) return null;
  let v = String(value).trim();
  {
    /* A token whose value is itself a token expression. */
    const alias = /^var\((--[a-z-]+)\)$/i.exec(v);
    if (alias && PAL[alias[1]] && PAL[alias[1]][mode] && /var\(/.test(PAL[alias[1]][mode])) {
      return resolve(PAL[alias[1]][mode], mode, (depth || 0) + 1);
    }
  }
  // rgb(var(--x-rgb) / N%)  and  rgb(var(--x-rgb))
  let m = /^rgb\(\s*var\((--[a-z-]+)\)\s*(?:\/\s*([\d.]+)%\s*)?\)$/i.exec(v);
  if (m) {
    const trip = PAL[m[1]] && PAL[m[1]][mode];
    if (!trip) return null;
    const p = trip.split(/[\s,]+/).map(Number);
    if (p.length < 3 || p.some((n) => !isFinite(n))) return null;
    return [p[0], p[1], p[2], m[2] === undefined ? 1 : Number(m[2]) / 100];
  }
  m = /^var\((--[a-z-]+)\)$/i.exec(v);
  if (m) {
    const raw = PAL[m[1]] && PAL[m[1]][mode];
    return raw ? parseColor(raw) : null;
  }
  return parseColor(v);
}

/** Largest channel difference once both are composited over the mode's page.
 *
 * NOTHING AND NOTHING ARE THE SAME THING. This returned Infinity when either
 * side was absent, which sounds cautious and is simply wrong: a mode where the
 * rule declares nothing before and nothing after has not changed. It made the
 * tool reject its own easiest cases —
 *
 *     body.super-light-mode #toast { background: #FFFFFF !important }
 *
 * where #FFFFFF IS super-light's --ink to the byte, and light and dark declare
 * nothing at all for that selector. Fifty-odd provably free conversions were
 * reported as "a real colour choice" because two nulls compared as a mismatch.
 * One side present and the other absent is still Infinity — that is a genuine
 * change in what the rule contributes. */
function delta(a, b, mode) {
  if (!a && !b) return 0;
  if (!a || !b) return Infinity;
  const g = parseColor((PAL['--ink'] && PAL['--ink'][mode]) || '#09090b') || [0, 0, 0, 1];
  const over = (c) => [0, 1, 2].map((i) => c[3] * c[i] + (1 - c[3]) * g[i]);
  const A = over(a), B = over(b);
  return Math.max(...A.map((v, i) => Math.abs(v - B[i])));
}

// ── Rule parsing ────────────────────────────────────────────────────────────

const COLOR_PROPS = /^(color|background|background-color|border-color|border-[a-z]+-color|fill|stroke|outline-color)$/i;

/** Every declaration in the file, with where it is and what selector owns it. */
function declarations(css) {
  const out = [];
  const noComment = css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const stack = [];
  let i = 0, selStart = 0;
  while (i < noComment.length) {
    const ch = noComment[i];
    if (ch === '{') {
      const sel = noComment.slice(selStart, i).trim();
      stack.push(sel);
      // find the body of this block
      if (!sel.startsWith('@')) {
        let depth = 1, j = i + 1;
        while (j < noComment.length && depth > 0) {
          if (noComment[j] === '{') depth++;
          else if (noComment[j] === '}') depth--;
          j++;
        }
        const body = noComment.slice(i + 1, j - 1);
        // only leaf rules carry declarations we care about
        if (!/\{/.test(body)) {
          let k = 0;
          for (const part of body.split(';')) {
            const at = i + 1 + k;
            k += part.length + 1;
            const c = part.indexOf(':');
            if (c < 0) continue;
            const prop = part.slice(0, c).trim();
            const val = part.slice(c + 1);
            if (!COLOR_PROPS.test(prop)) continue;
            out.push({
              sel, prop: prop.toLowerCase(), value: val,
              media: stack.filter((s) => s.startsWith('@')).join(' & '),
              start: at + c + 1, end: at + part.length,
            });
          }
        }
      }
      selStart = i + 1;
      i++;
      continue;
    }
    if (ch === '}') { stack.pop(); selStart = i + 1; }
    i++;
  }
  return out;
}

/** 'body.light-mode .x' → { mode:'light', key:'.x' } */
function classify(sel) {
  const parts = sel.split(',').map((s) => s.trim());
  const modeOf = (s) => s.includes('super-light-mode') ? 'super-light'
    : s.includes('light-mode') ? 'light' : 'dark';
  const modes = new Set(parts.map(modeOf));
  if (modes.size !== 1) return null;          // a mixed selector list is not ours to reason about
  const mode = [...modes][0];
  const key = parts.map((s) => s
    .replace(/body\.super-light-mode\b/g, '')
    .replace(/body\.light-mode\b/g, '')
    .replace(/\s+/g, ' ').trim()).join(',');
  return { mode, key };
}

// ── The proposals ───────────────────────────────────────────────────────────

/* Only tokens whose meaning is the same kind of thing as the literal being
   replaced. --ink is the page, --paper is the text on it, --zw-theme-surface is
   a panel lifted off the page. */
/* A ROLE HAS A SHAPE, and matching only on value is how a refactor smears two
 * roles together.
 *
 * --zw-cream is documented as "the label on a foreground-coloured surface". Let
 * it match on value alone and it also swallows `body.light-mode .lp-hero {
 * background: #e8e5de }` — two parts in 255 away, so provably no visual change
 * today, and a landing hero that turns white the first time somebody sets
 * `cream` to brighten their button labels. The colours agreed; the meanings did
 * not.
 *
 * --zw-surface is a background, and matching it against `color:#111` on the
 * carousel arrows would have made the glyph follow the theme while the white
 * circle it sits in stayed fixed.
 *
 * So each candidate declares which properties it is allowed to answer for.
 * --zw-accent has no restriction because an accent genuinely is all three: it
 * is text on a link, a border on a focused field, and the fill of a rating bar.
 */
const CANDIDATES = [
  { token: 'var(--ink)' },
  { token: 'var(--paper)' },
  { token: 'var(--zw-theme-surface)' },
  { token: 'var(--zw-cream)', props: /^color$/ },
  { token: 'var(--zw-surface)', props: /^background(-color)?$/ },
  { token: 'var(--zw-fg-hover)', props: /^(background(-color)?|border(-[a-z]+)?-color)$/ },
  { token: 'var(--zw-accent)' },
];
function alphaCandidates(a) {
  const pct = +(a * 100).toFixed(2);
  return ['--bg-rgb', '--fg-rgb'].map((t) => `rgb(var(${t}) / ${pct}%)`);
}

function run(write) {
  const skipped = {};
  let converted = 0, worst = 0, worstAt = '';
  const note = (why, where, val) => {
    (skipped[why] = skipped[why] || { n: 0, ex: [] }).n++;
    if (skipped[why].ex.length < 3) skipped[why].ex.push(where + '  ' + val.trim().slice(0, 48));
  };

  for (const file of FILES) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const css = fs.readFileSync(p, 'utf8');
    /* Parse each <style> block on its own, then shift every offset to where it
       really sits in the file. Concatenating first would be simpler and would
       put the edits in the wrong place. */
    const decls = [];
    for (const seg of styleSegments(css, file)) {
      for (const d of declarations(seg.text)) {
        decls.push({ ...d, start: d.start + seg.at, end: d.end + seg.at });
      }
    }

    /* What each (media, selector, property) resolves to in each mode today. */
    const index = new Map();
    for (const d of decls) {
      const c = classify(d.sel);
      if (!c) continue;
      const k = d.media + '||' + c.key + '||' + d.prop;
      if (!index.has(k)) index.set(k, {});
      index.get(k)[c.mode] = d.value;
    }
    const effective = (k, mode) => {
      const e = index.get(k) || {};
      if (mode === 'dark') return e.dark;
      if (mode === 'light') return e.light !== undefined ? e.light : e.dark;
      return e['super-light'] !== undefined ? e['super-light']
        : e.light !== undefined ? e.light : e.dark;
    };

    const edits = [];
    for (const d of decls) {
      /* !important is a cascade priority, not a colour. Skipping these was a
         reflex and it cost the biggest single group of convertible rules — the
         header actions, the modal closes, the cookie banner. It is stripped for
         comparison and put back on the way out, so the rule keeps winning
         exactly what it won before. */
      const bang = /!important\s*$/i.test(d.value.trim());
      const raw = d.value.trim().replace(/\s*!important\s*$/i, '');
      if (/var\(/.test(raw)) continue;
      const lit = parseColor(raw);
      if (!lit) { if (/#|rgba?\(/.test(raw)) note('multi-part or non-plain value', file, raw); continue; }
      if (lit[0] === 0 && lit[1] === 0 && lit[2] === 0) { note('shadows & scrims (absolute by design)', file, raw); continue; }

      const c = classify(d.sel);
      if (!c) { note('mixed-mode selector list', file, raw); continue; }

      /* SITTING ON SOMETHING THAT IS NOT THE PAGE.
         .zw-hc-dots draws a hard-coded white pill over the hero carousel and
         the dots live inside it, so their colour has to contrast with THAT
         pill, not with the theme. This tool cannot see what is behind an
         element — it reads rules, not layout — so the handful of places where
         the answer comes from the layout are named here. It is the same reason
         quick-add-modal.css is excluded from the other pass. */
      if (/\.zw-hc-(dot|prev|next|pause)\b/.test(d.sel)) { note('on a fixed surface, not the page', file, raw); continue; }

      /* <html> IS :root, and the palette lives on body. --ink on html therefore
         resolves to the dark value in every mode, so `html:has(body.light-mode)
         { background: var(--ink) }` would paint a light store's ground dark.
         These rules exist precisely because the token cannot reach up there;
         they are the one place a literal is the only correct answer. */
      if (/(^|,)\s*html\b/.test(d.sel)) { note('the page ground, above where the tokens live', file, raw); continue; }

      const k = d.media + '||' + c.key + '||' + d.prop;

      /* Today's resolved colour, per mode, with this declaration in place.
         Compared with !important stripped from every side, so a rule that has
         it is judged on its colour like any other. */
      const strip = (v) => (v === undefined ? v : String(v).replace(/\s*!important\s*$/i, '').trim());
      const before = MODES.map((m) => resolve(strip(effective(k, m)), m));

      const usable = lit[3] === 1
        ? CANDIDATES.filter((c) => !c.props || c.props.test(d.prop)).map((c) => c.token)
        : alphaCandidates(lit[3]);

      let chosen = null, chosenWorst = Infinity;
      for (const cand of usable) {
        /* Substitute the candidate wherever this declaration is the one that
           wins, and re-resolve all three modes. */
        const after = MODES.map((m) => {
          const eff = effective(k, m);
          return resolve(eff === d.value ? cand : strip(eff), m);
        });
        const w = Math.max(...MODES.map((m, i) => delta(before[i], after[i], m)));
        if (w < chosenWorst) { chosenWorst = w; chosen = cand; }
      }

      if (chosen && chosenWorst <= TOLERANCE) {
        edits.push({ start: d.start, end: d.end, text: ' ' + chosen + (bang ? ' !important' : '') });
        converted++;
        if (chosenWorst > worst) { worst = chosenWorst; worstAt = file + '  ' + raw + ' → ' + chosen; }
      } else {
        note('no token within ' + TOLERANCE + '/255 (a real colour choice)', file, raw
          + (chosen ? '  nearest ' + chosen + ' off by ' + chosenWorst.toFixed(1) : ''));
      }
    }

    if (write && edits.length) {
      let out = css;
      for (const e of edits.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
      }
      fs.writeFileSync(p, out);
    }
    if (edits.length) console.log('  ' + file.padEnd(32) + String(edits.length).padStart(5) + ' converted');
  }

  console.log('\n  ' + converted + ' declarations converted' + (write ? '' : ' (report only — pass --write)'));
  console.log('  largest resolved difference in any built-in theme: ' + worst.toFixed(2) + ' / 255');
  if (worstAt) console.log('    at ' + worstAt);
  console.log('\n  left alone, and why:');
  for (const [why, s] of Object.entries(skipped).sort((a, b) => b[1].n - a[1].n)) {
    console.log('    ' + String(s.n).padStart(4) + '  ' + why);
    s.ex.forEach((e) => console.log('          · ' + e));
  }
  console.log('');
}

run(process.argv.includes('--write'));
