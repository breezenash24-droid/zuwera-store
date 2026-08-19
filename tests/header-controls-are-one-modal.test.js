/* Everything about the header's controls, in the modal that changes the header.
 *
 * Three answers about the same bar were spread across three screens, none of
 * them the one you were looking at when you wanted them:
 *
 *   where the account link lives   a per-theme-mode token in Appearance → Themes
 *   glyphs or words                the same, one row below it
 *   the account menu's four rows   Settings → Bag panel
 *
 * The per-theme-mode ones were on the wrong axis outright: the same question
 * had to be answered again on every theme, and four themes could hold four
 * different answers to "where does the account link live".
 *
 * THE RULES THIS FILE HOLDS:
 *
 *  1. '' is a third state, not a default. The header row carries an answer only
 *     when one was given, and absent hands the question back to the theme —
 *     storing a value that happens to match today's theme would quietly stop
 *     the header following a theme switch, with no control saying so.
 *  2. The builder does not become a second owner of the bag menu. It writes
 *     site_settings.bag_panel through a draft, which is the key Settings
 *     already writes and storefront-features.js already reads.
 *  3. All four answers reach the first frame the same way the placement does:
 *     baked by the build, stamped at the edge, cached for the next load. An
 *     answer that only arrives with the module is an answer you watch happen.
 *  4. `icons` and `bag` are ANSWERS and must clear a bake that disagrees.
 *     Everywhere else in this codebase the rule is "clear only what you wrote",
 *     which protects a build stamp from a theme's silence — but an explicit
 *     choice is not silence, and treating it as such would make those two
 *     values the only ones in the modal that did nothing.
 *  5. The builder's list of rows and the panel's own list name the same four
 *     things, in the same order, with the same fallback labels.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const B = read('builder.html');
const SRC = read('header-layouts.js');
const TE = read('theme-engine.js');
const FEAT = read('storefront-features.js');
const PRE = read('scripts/theme-preboot.head.js');
const HPRE = read('scripts/header-preboot.head.js');
const MID = read('functions/_middleware.js');
const STAMP = read('scripts/stamp-header-layout.js');
const SAVE = read('functions/api/save-page-builder.js');
const PV = read('functions/api/preview-config.js');

console.log('\nOne modal for the whole header\n');

/* ── 1 · the modal ───────────────────────────────────────────────────────── */
{
  ok('the header modal has a second tab for the controls',
    /id="hdrTabIcons"/.test(B) && /id="hdrPaneIcons"/.test(B) && /function hdrTab\(/.test(B));
  /* Per device, and any combination — the two scopes this replaces could say
     "phone and tablet together" or "everywhere", and could not say desktop
     alone. Eight combinations, two of them reachable. */
  ok('glyphs or words is answerable per device',
    ['hdrLbPhone', 'hdrLbTablet', 'hdrLbDesktop'].every((id) => B.includes('id="' + id + '"'))
    && /function toggleHdrLabel\(dev\)\{/.test(B));
  ok('...and every device is on the header’s own 900px boundary, not a second one',
    /@media \(max-width: 600px\)[\s\S]{0,240}data-zw-iconlabels~="phone"/.test(read('storefront-cohesion.css'))
    && /@media \(min-width: 601px\) and \(max-width: 900px\)[\s\S]{0,240}data-zw-iconlabels~="tablet"/.test(read('storefront-cohesion.css'))
    && /@media \(min-width: 901px\)[\s\S]{0,240}data-zw-iconlabels~="desktop"/.test(read('storefront-cohesion.css')),
    'it used to switch at 1024px, which is nothing else in the header’s boundary');
  ok('...and the old spellings still work, so baked HTML is not blanked',
    /\[data-zw-iconlabels="mobile"\]/.test(read('storefront-cohesion.css'))
    && /\[data-zw-iconlabels="always"\]/.test(read('storefront-cohesion.css')));
  ok('where the account link lives is answerable there',
    /id="hdrAcctBag"/.test(B) && /id="hdrAcctHeader"/.test(B));
  ok('and the four menu rows are, each with a switch and a name',
    /id="hdrBagRows"/.test(B) && /data-bagrow=/.test(B) && /data-baglabel=/.test(B));
  ok('the support address too, since one row is an email link',
    /id="hdrBagMail"/.test(B) && /function setBagMail\(/.test(B));

  /* Apply exists for the gallery, where you browse ten arrangements and must be
     able to look without changing anything. A two-state switch is its own
     preview, so Apply there would be ceremony — and leaving the button visible
     but inert would read as "these have not been applied either". */
  ok('the controls act on click, and Apply goes away with the gallery',
    /getElementById\('hdrCfgApply'\)\.hidden = icons/.test(B)
    && /function setHdrAccount\(v\)\{[\s\S]{0,200}sendChrome\(\)/.test(B));
  ok('...and the footer says so rather than leaving you to guess',
    /Every switch here updates the preview as you press it/.test(B));
  ok('...and Cancel does not promise an undo it does not have',
    /hdrCfgClose'\)\.textContent = icons \? 'Done' : 'Cancel'/.test(B),
    'nothing on this tab is pending; it has all been applied already');
  ok('custom rows are named as belonging to Settings, not silently missing',
    /custom row/.test(B) && /left alone by this modal/.test(B));
}

/* ── 2 · '' is a third state ─────────────────────────────────────────────── */
{
  ok('the draft carries an answer only when one was given',
    /if \(chromeHdrAccount\) out\.account = chromeHdrAccount;/.test(B)
    && /if \(chromeHdrLabels\) out\.iconLabels = chromeHdrLabels;/.test(B),
    'storing today’s theme value would stop the header following a theme switch');
  ok('the engine treats absent as "the theme still answers"',
    /var v = hdrAccount \|\| \(themeValue === 'header' \? 'header' : ''\);/.test(TE)
    && /var v = hdrLabels \|\| themeValue \|\| '';/.test(TE));
  ok('...and translates the theme’s older spelling rather than teaching it to CSS',
    /LABEL_ALIAS = \{ mobile: 'phone tablet', always: 'phone tablet desktop', icons: 'none' \}/.test(TE),
    'one vocabulary below that line');
  ok('...and the theme editors say they are the fallback now',
    (read('admin-themes.js').match(/This is the fallback/g) || []).length >= 2,
    'a control that silently loses is worse than one that is gone');
  ok('the module validates the two enums against one table',
    /var EXTRAS = \{/.test(SRC) && /account:\s*\{ bag: 1, header: 1 \}/.test(SRC));
  ok('...and the device list through one normaliser, order included',
    /function deviceList\(v\)/.test(SRC) && /var DEVICES = \['phone', 'tablet', 'desktop'\]/.test(SRC),
    'unordered, "tablet phone" and "phone tablet" would compare as different answers');
}

/* ── 3 · they reach the first frame ──────────────────────────────────────── */
{
  ok('the build bakes both', /data-zw-iconlabels="/.test(STAMP) && /data-zw-account="header"/.test(STAMP));
  ok('...and the account one onto <body>, where its rule is anchored',
    /<body\\b\(\[\^>\]\*\)>/.test(STAMP) && /OURS_BODY/.test(STAMP));
  ok('the edge stamps them too', /data-zw-iconlabels/.test(MID) && /bodyAttrsFrom/.test(MID)
    && /rw\.on\('body'/.test(MID));
  ok('the cache carries them, appended so an old tuple still reads',
    /ATTR_FIELDS = \['lines', 'account', 'iconLabels'\]/.test(SRC)
    && /parts\[5 \+ fi\]/.test(SRC));
  ok('the head pre-paint reads the words/glyphs field',
    /phone\|tablet\|desktop/.test(PRE) && /h\.setAttribute\(_il, _hc\[7\]\)/.test(PRE));
  /* It hides a button that is IN the header, so it has to land before the
     header is parsed. That rules out the after-nav block, which is where it
     first went — and <head> has no <body>, so it goes onto <html> and the
     stylesheet accepts it from either element. */
  ok('the account one is read in <head>, early enough to beat the header',
    /_hc\[6\] === 'header' \|\| _hc\[6\] === 'bag'/.test(PRE));
  ok('...and NOT in the block that runs after the nav, where it would be late',
    !/setAttribute\('data-zw-account'/.test(HPRE),
    'the class beside it is early for exactly this reason');
  ok('the stylesheet takes the answer from either element',
    /html:not\(\[data-zw-account="header"\]\) body\.zwf-bagpanel-on:not\(\[data-zw-account="header"\]\)/.test(read('storefront-cohesion.css'))
    && /html\[data-zw-account="bag"\] body\.zwf-bagpanel-on/.test(read('storefront-cohesion.css')));
  ok('...and the module’s injected copy says the same thing',
    /html\[data-zw-account="bag"\] body\.zwf-bagpanel-on/.test(FEAT),
    'two stylesheets for one rule is how they start disagreeing');
}

/* ── 4 · an answer may clear a bake; silence may not ─────────────────────── */
{
  ok('the engine clears on an explicit "in the bag"',
    /else if \(acctWritten \|\| hdrAccount === 'bag'\)/.test(TE));
  /* "Glyphs everywhere" is now the value 'none' — a list naming no device —
     rather than a removal. It has to overrule what the build baked, and only
     the truly absent case removes anything. */
  ok('...and "glyphs everywhere" is a value that overrules the bake, not a removal',
    /if \(v\) \{ root\.setAttribute\('data-zw-iconlabels', v\); labelsWritten = true; \}/.test(TE)
    && /else if \(labelsWritten\)/.test(TE));
  ok('the head pre-paint writes it too, rather than removing',
    /\^\(none\|/.test(PRE));
  /* "In the bag" does not clear anything here — it WRITES 'bag' onto <html>,
     and the second stylesheet rule makes that beat a bake on <body> saying
     otherwise. Clearing would have been the wrong verb: there is a baked
     attribute on an element this block cannot reach. */
  ok('and "in the bag" outranks the bake rather than trying to erase it',
    /h\.setAttribute\(_ia, _hc\[6\]\)/.test(PRE)
    && /html\[data-zw-account="bag"\] body\.zwf-bagpanel-on/.test(read('storefront-cohesion.css')));
  ok('the edge validates the list before it lands on the element',
    /\^\(none\|\(phone\|tablet\|desktop\)/.test(MID),
    'a junk value would read as a scope nobody wrote');
  ok('...and can still remove where removal is the answer',
    /if \(v === null\) el\.removeAttribute\(k\)/.test(MID));
  ok('the build bakes whatever list the row names',
    /if \(labels\) keep \+= ' data-zw-iconlabels="'/.test(STAMP)
    && /\^\(none\|\(phone\|tablet\|desktop\)/.test(STAMP));
}

/* ── 5 · one owner for the menu ──────────────────────────────────────────── */
{
  ok('the builder writes the key Settings already owns',
    /bag_panel_draft: 'bag_panel'/.test(SAVE) && /bag_panel_draft/.test(PV),
    'a second copy of these rows is the announcement-bar fault all over again');
  ok('...stored verbatim, so nothing invents a row called updated_at',
    /'bag_panel', 'bag_panel_draft',/.test(SAVE));
  ok('...and read-modify-write, so the custom rows survive a builder save',
    /function bagRowCfg\(key\)\{/.test(B) && /bag:  \['bag_panel_draft',\s*\(\) => chromeBag \|\| \{\}\]/.test(B));
  ok('the draft reaches the canvas by message and preview link, never by fetch',
    /ZW_BAG_PREVIEW/.test(FEAT) && /ZW_BAG_PREVIEW/.test(B)
    && /__zwPreviewReady[\s\S]{0,200}pv\.bag_panel/.test(FEAT),
    'bag_panel_draft is not public-read, and unpublished copy is not a shopper’s business');
  ok('a builder edit does not poison the shopper cache',
    /function bagPreviewCfg\(cfg\) \{[\s\S]{0,220}\}/.test(FEAT)
    && !/bagPreviewCfg[\s\S]{0,220}localStorage\.setItem/.test(FEAT));

  /* The builder's list and the panel's list name the same four rows. Two lists
     is how the modal would start offering a row the panel does not draw. */
  const rows = [...B.matchAll(/\['(orders|saves|account|support)',\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  ok('the builder offers exactly the rows the panel draws', rows.length === 4,
    'found ' + rows.length);
  for (const [key, label] of rows) {
    ok('  ' + key + ' falls back to the same name the panel uses',
      FEAT.includes("bagRow('" + key + "', '" + label + "')"),
      'panel and builder disagree about ' + key);
  }
  ok('a blank name is stored as absent, not as today’s wording',
    /if\(t\) bagRowCfg\(key\)\.label=t; else delete bagRowCfg\(key\)\.label;/.test(B));
}

/* ── 6 · it travels with the rest of the chrome draft ────────────────────── */
{
  ok('publish promotes the menu along with everything else',
    /const want = pub \? \['nav','bar','copy','header','bag'\]/.test(B));
  ok('the load reads its draft first, then what is live',
    /fetchSettingAuthed\('bag_panel_draft'\), fetchSettingAuthed\('bag_panel'\)/.test(B));
  ok('...and says so on the status line, like the other four',
    /chromeFound\.push\('account menu'\)/.test(B));
  ok('the save toast names it', /bag:'account menu'/.test(B));
}

/* ── 7 · what applies at which width, said out loud ──────────────────────── */
{
  console.log('\n  which widths each answer reaches');
  /* Arrangement is desktop-only because the stylesheet says so: below 900px
     every placement is undone. That is a real limit — a phone bar cannot hold
     three zones and a second row — and the gallery was silent about it, which
     let you pick a tile on the Tablet preview and watch nothing happen. */
  ok('placement is desktop-only in the stylesheet',
    /@media \(max-width: 900px\)[\s\S]{0,400}html\[data-zw-hdr\] :is\(#nav[\s\S]{0,200}order: 0/.test(read('storefront-cohesion.css')));
  ok('...and the modal says which width it applies at',
    /Applies at 900px and up/.test(B));
  ok('...and says it louder when you are previewing a narrower one',
    /pvMode==='mob' \|\| pvMode==='tab'/.test(B) && /will not change this preview/.test(B));
  ok('...and follows the preview rather than stating it once and going stale',
    /function setPvMode\(m\)\{[\s\S]{0,200}paintHdrScope\(\)/.test(B));

  /* The other two are whole-site questions, and saying so is what stops them
     growing per-device controls nobody would vary. */
  ok('the divider rule is outside the placement media query, so a phone shows it',
    /^html\[data-zw-hdr-lines="off"\]/m.test(read('storefront-cohesion.css')));
  ok('...and the modal says the non-placement answers apply at every width',
    /apply at every width/.test(B));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
if (fail) process.exit(1);
