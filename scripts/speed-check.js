#!/usr/bin/env node
/**
 * speed-check — what does a shopper actually download?
 *
 * Run it against the live site, or against any deploy preview, and it reports
 * the only numbers that matter for how fast a page feels:
 *
 *   TOTAL BYTES, compressed, as the browser receives them. Not the repo size:
 *   admin-main.js is 973 KB and no customer has ever downloaded a byte of it.
 *
 *   RENDER-BLOCKING BYTES. A script without defer/async stops the parser dead —
 *   it must arrive AND execute before anything paints. Ten kilobytes here cost
 *   more than a hundred further down the page.
 *
 *   REQUEST COUNT, and how much of it is files too small to be worth a request.
 *
 * WHAT IT CANNOT SEE, and this matters: analytics and ad tags inject themselves
 * from JavaScript, so nothing here counts Google Tag Manager, Meta, PostHog or
 * anything they pull in afterwards. On most storefronts that is the single
 * largest cost. Use the browser's Network tab for the real figure — this tool
 * measures what the SITE ships, which is the part you control by editing files.
 *
 *   node scripts/speed-check.js
 *   node scripts/speed-check.js --budget 300
 *   node scripts/speed-check.js https://some-preview.pages.dev/
 */

const DEFAULT_ORIGIN = 'https://zuwera.store';

const PAGES = [
  ['Homepage',   '/'],
  ['Product',    '/product?id=185c7f10-d692-40f2-8a4c-a4825b1d5a2d'],
  ['Collection', '/drop001'],
  ['Bag',        '/bag'],
  ['Checkout',   '/checkout'],
];

const args = process.argv.slice(2);
const budgetArg = args.indexOf('--budget');
const BUDGET_KB = budgetArg >= 0 ? Number(args[budgetArg + 1]) || 0 : 0;
const origin = (args.find((a) => a.startsWith('http')) || DEFAULT_ORIGIN).replace(/\/$/, '');

const KB = (n) => (n / 1024).toFixed(0).padStart(5) + ' KB';

const zlib = require('zlib');

/* BYTES ON THE WIRE, which is the only size a shopper waits for.
 *
 * fetch() decompresses transparently and Cloudflare streams compressed
 * responses without a content-length, so neither the decoded length nor the
 * header gives the real figure — the decoded length overstates everything three
 * or four times over and would make every judgement below wrong.
 *
 * So the body is re-compressed here with brotli, which is what Cloudflare
 * serves. It will not match their output byte for byte — their quality setting
 * is theirs — but it is the right size, and more importantly it is measured the
 * same way every run, which is what makes two runs comparable. That is the
 * question this tool exists to answer: did the change I just made cost
 * anything?
 */
const wire = (buf) => zlib.brotliCompressSync(buf, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
}).length;

async function weigh(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { bytes: 0, missing: true };
    const body = Buffer.from(await res.arrayBuffer());
    /* Images and fonts are already compressed; running brotli over a JPEG makes
       it bigger and would report a number no browser will ever see. */
    const type = String(res.headers.get('content-type') || '');
    const compressible = /text|javascript|json|xml|svg|css/i.test(type);
    return {
      bytes: compressible ? wire(body) : body.length,
      raw: body.length,
      text: body.toString('utf8'),
    };
  } catch (_) {
    return { bytes: 0, missing: true };
  }
}

function assetsIn(html, base) {
  const out = [];
  const add = (src, blocking) => {
    if (!src || src.startsWith('data:')) return;
    const url = src.startsWith('http') ? src
      : new URL(src.startsWith('/') ? src : '/' + src, base).href;
    if (out.some((a) => a.url === url)) return;
    out.push({ url, blocking, own: url.startsWith(base.replace(/\/$/, '')) });
  };

  const script = /<script([^>]*)\ssrc="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = script.exec(html))) {
    const attrs = (m[1] || '') + (m[3] || '');
    add(m[2], !/\bdefer\b|\basync\b/.test(attrs));
  }
  /* Every stylesheet blocks rendering. There is no defer for CSS, which is why
     they are counted as blocking without looking at attributes. */
  const link = /<link[^>]*>/g;
  while ((m = link.exec(html))) {
    const tag = m[0];
    if (!/stylesheet/.test(tag)) continue;
    const href = /href="([^"]+)"/.exec(tag);
    if (href) add(href[1], true);
  }
  return out;
}

(async () => {
  console.log('\n  What a shopper downloads — ' + origin + '\n');
  let worst = 0, overBudget = [];

  for (const [name, path] of PAGES) {
    const url = origin + path;
    const doc = await weigh(url);
    if (doc.missing) { console.log('  ' + name.padEnd(12) + '  could not be fetched'); continue; }

    const assets = assetsIn(doc.text, origin + '/');
    const weighed = await Promise.all(assets.map(async (a) => ({ ...a, ...(await weigh(a.url)) })));

    const own = weighed.filter((a) => a.own).reduce((n, a) => n + a.bytes, 0);
    const third = weighed.filter((a) => !a.own).reduce((n, a) => n + a.bytes, 0);
    /* The document itself always blocks — it is the thing being parsed. */
    const blocking = doc.bytes + weighed.filter((a) => a.blocking).reduce((n, a) => n + a.bytes, 0);
    const total = doc.bytes + own + third;
    const tiny = weighed.filter((a) => a.bytes > 0 && a.bytes < 2048);

    worst = Math.max(worst, total);
    if (BUDGET_KB && total / 1024 > BUDGET_KB) overBudget.push(name);

    console.log('  ' + name.toUpperCase());
    console.log('    document            ' + KB(doc.bytes));
    console.log('    own assets (' + String(weighed.filter((a) => a.own).length).padStart(2) + ')     ' + KB(own));
    if (third) console.log('    third-party (' + String(weighed.filter((a) => !a.own).length).padStart(2) + ')    ' + KB(third));
    console.log('    TOTAL               ' + KB(total) + '   over ' + (weighed.length + 1) + ' requests');
    console.log('    blocks first paint  ' + KB(blocking) + '   in ' + (weighed.filter((a) => a.blocking).length + 1) + ' files');
    if (tiny.length >= 5) {
      console.log('    under 2 KB          ' + String(tiny.length).padStart(5) + ' files, ' + KB(tiny.reduce((n, a) => n + a.bytes, 0)).trim()
        + '  — a request each, for very little');
    }

    const top = weighed.filter((a) => a.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 4);
    for (const a of top) {
      const label = a.own ? a.url.split('/').pop().split('?')[0] : new URL(a.url).host;
      console.log('      ' + KB(a.bytes) + '  ' + label
        + (a.blocking ? '   [blocks paint]' : '') + (a.own ? '' : '   [third-party]'));
    }
    console.log('');
  }

  console.log('  Not counted: anything analytics or ad tags load AFTER the page runs.');
  console.log('  For that figure, open DevTools → Network and read the total there.\n');

  if (BUDGET_KB) {
    if (overBudget.length) {
      console.log('  OVER BUDGET (' + BUDGET_KB + ' KB): ' + overBudget.join(', ') + '\n');
      process.exit(1);
    }
    console.log('  All pages within ' + BUDGET_KB + ' KB. Heaviest: ' + KB(worst).trim() + '\n');
  }
})();
