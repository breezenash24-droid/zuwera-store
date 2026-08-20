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
  ok('glyphs or words is answerable per device, as a picture of each one',
    /id="hdrDevs"/.test(B) && /data-dev="/.test(B)
    && /function toggleHdrLabel\(dev\)\{/.test(B)
    && ['phone', 'tablet', 'desktop'].every((d) => B.includes("['" + d + "',")));
  /* ONE WRITER for that answer. The cards and the reset both go through it,
     so "an empty list means 'none', not ''" is decided once — '' would hand
     the question back to the theme, which is a different answer and not what
     either control means. */
  ok('...through a single writer, so empty means the same thing to both',
    /function setHdrLabels\(devs\)\{/.test(B)
    && /const next=devs\.length\?\(L\?L\.deviceList\(devs\.join\(' '\)\):devs\.join\(' '\)\):'none';/.test(B)
    && (B.match(/chromeHdrLabels=next;/g) || []).length === 1);
  /* THE STATE IS ALWAYS STATED. The line under the cards read
     `words.length ? '' : …`, so the one state it never described in words was
     the one somebody would want described: words turned on. A store ends up
     showing WORDS where its owner remembers choosing icons, and no sentence
     anywhere confirms which of them is right. */
  ok('...and the modal says in words which answer is saved, in every state',
    /'Saved: icons on every device\.'/.test(B)
    && /'Saved: words on every device\.'/.test(B)
    && /'Saved: words on '\+words\.join\(', '\)/.test(B)
    && !/words\.length \? '' :/.test(B));
  /* And a way back that is one press rather than finding every lit card. */
  ok('...with a one-press return to icons, shown only when it would do something',
    /id="hdrLbReset"/.test(B)
    && /rst\.hidden = !words\.length;/.test(B)
    && /rst\.onclick = \(\) => setHdrLabels\(\[\]\);/.test(B));
  ok('...and every device is on the header’s own 900px boundary, not a second one',
    /@media \(max-width: 600px\)[\s\S]{0,240}data-zw-iconlabels~="phone"/.test(read('storefront-cohesion.css'))
    && /@media \(min-width: 601px\) and \(max-width: 900px\)[\s\S]{0,240}data-zw-iconlabels~="tablet"/.test(read('storefront-cohesion.css'))
    && /@media \(min-width: 901px\)[\s\S]{0,240}data-zw-iconlabels~="desktop"/.test(read('storefront-cohesion.css')),
    'it used to switch at 1024px, which is nothing else in the header’s boundary');
  ok('...and the old spellings still work, so baked HTML is not blanked',
    /\[data-zw-iconlabels="mobile"\]/.test(read('storefront-cohesion.css'))
    && /\[data-zw-iconlabels="always"\]/.test(read('storefront-cohesion.css')));
  /* Asked with the other four, on the account's own row, rather than in a
     section of its own that phrased the same question differently. */
  ok('where the account link lives is answerable there, on its row',
    /function bagRowWhere\(key\)\{/.test(B)
    && /if\(key==='account'\) return \(chromeHdrAccount\|\|'bag'\)==='header'/.test(B)
    && !/id="hdrAcctBag"/.test(B));
  ok('...and its answer is stored once, not copied under the row too',
    /if\(key==='account'\)\{\s*chromeHdrAccount=w;/.test(B),
    'a second copy is what lets the two disagree');
  ok('and the four menu rows are, each with a switch and a name',
    /id="hdrBagRows"/.test(B) && /data-bagrow=/.test(B) && /data-baglabel=/.test(B));
  ok('the support address too, since one row is an email link',
    /id="hdrBagMail"/.test(B) && /function setBagMail\(/.test(B));

  /* THE MODAL STAGES. Every switch reaches the PREVIEW as you press it —
     watching the header change is the whole point of the cards — and only
     Apply writes it to the draft. That is what makes Cancel a real undo, and
     it is why both tabs now have the same two buttons meaning the same two
     things. Hiding Apply on one tab made the halves behave differently for no
     reason a reader could see, and left Cancel closing without undoing. */
  ok('every switch reaches the preview as it is pressed',
    /function setBagRowWhere\(key,where\)\{[\s\S]{0,600}sendChrome\(\)/.test(B));
  ok('...but only Apply writes it to the draft',
    /function applyHeaderCfg\(\)\{/.test(B) && /hdrCfgTouched=false;/.test(B));
  ok('...and Cancel puts back what the draft held when you opened it',
    /hdrCfgWas = \{/.test(B)
    && /function closeHeaderCfg\(\)\{[\s\S]{0,400}chromeHeader=hdrCfgWas\.header/.test(B),
    'a Cancel that only closes is a button that lies about what it does');
  ok('...without unmarking an edit made before the modal opened',
    /closeHeaderCfg\(\)\{[\s\S]{0,600}\}/.test(B) && !/closeHeaderCfg[\s\S]{0,600}chromeDirtyKeys\.clear/.test(B));
  ok('...and the footer says which button does which',
    /Apply keeps it; Cancel puts it back/.test(B));
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
    /ATTR_FIELDS = \['lines', 'account', 'iconLabels', 'order'\]/.test(SRC)
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

/* ── 6b · the order the controls sit in ──────────────────────────────────── */
{
  console.log('\n  the order they sit in');
  const CSS = read('storefront-cohesion.css');

  /* `order`, on children of a flex row both dialects already have. Nothing is
     moved — the rule this header has been rebuilt around since the picker that
     tried to move things could not. */
  /* Through the SAME custom properties the theme's icon order uses, not a
     second set of rules declaring the same property. Two systems writing
     `order` through differently-shaped selectors is a specificity contest, and
     it was won by a different system for each control — measured, stylesheet
     only, with the value "search account bag": bag 3, account 2, search 2. The
     arrangement's answer never reached the search control, because every other
     control is an id and the search button is a class. */
  ok('ordering is `order` on the existing row, not moved markup',
    /html\[data-zw-hdr-order\] \{\s*--zw-ord-search: 2; --zw-ord-account: 2; --zw-ord-login: 2; --zw-ord-bag: 2;/.test(CSS)
    && !/appendChild|insertBefore/.test(read('header-layouts.js').replace(/\/\*[\s\S]*?\*\//g, '')));
  /* The one exception is the promoted row, which is not one of the theme's
     seven controls and so has no property of its own — and nothing else
     declares `order` for it, so there is no contest for it to lose. */
  ok('...and no control gets `order` from two places',
    (CSS.match(/html\[data-zw-hdr-order[^\]]*\][^{]*\{ order:/g) || [])
      .every((r) => r.includes('.zwf-hdr-row')),
    'the arrangement sets the properties; the icon block turns them into order');
  /* CSS cannot read a position out of an attribute, so the default is the
     middle and only the two ends are named. Six arrangements, seven rules. */
  for (const c of ['search', 'account', 'bag']) {
    ok('  ' + c + ' has a rule for each end of the row',
      CSS.includes('html[data-zw-hdr-order^="' + c + '"]')
      && CSS.includes('html[data-zw-hdr-order$="' + c + '"]'));
  }
  /* SIGNED IN AND SIGNED OUT ARE THE SAME CONTROL. The nav ships both buttons
     and a render-blocking rule keeps one; "account" in the order has to place
     whichever survived, or the header reads correctly to a visitor and wrongly
     to a customer. It is also the state where getting it wrong is most visible,
     because signed in that control is a WORD — the customer's own name — so a
     late swap moves text rather than a magnifier. Reported exactly that way:
     "when you're not logged in it loads the correct order, but when you're
     signed in it shows the wrong order first". */
  for (const end of ['^', '$']) {
    const rule = new RegExp('html\\[data-zw-hdr-order\\' + end
      + '="account"\\] *\\{ --zw-ord-account: (\\d); --zw-ord-login: (\\d); \\}');
    const m = CSS.match(rule);
    ok('  the account and the login button move together (' + end + '=)',
      !!m && m[1] === m[2],
      'one is hidden at any moment, and which one depends on the visitor');
  }

  ok('the menu button is pinned last rather than offered as a choice',
    /html\[data-zw-hdr-order\] \{[\s\S]{0,160}--zw-ord-menu: 9;/.test(CSS),
    'on the information header it is not even inside the group');

  /* Always all three, completed rather than rejected: a partial answer would
     leave the stylesheet to invent a place for whatever was missing. */
  const box = require('vm').createContext({
    window: null, document: { readyState: 'complete', querySelector: () => null, addEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ ok: false }), setTimeout, clearTimeout, console,
  });
  box.window = box;
  require('vm').runInContext(read('header-layouts.js'), box);
  const H = box.ZWHeaderLayouts;
  ok('a partial order is completed, never left partial',
    H.controlOrder('bag') === 'bag search account');
  ok('a duplicate does not produce a duplicate', H.controlOrder('bag bag search') === 'bag search account');
  ok('junk is dropped rather than passed through', H.controlOrder('nonsense') === '');
  ok('and an unanswered order stays unanswered', H.controlOrder('') === '');

  /* The picture is drawn from the same module the storefront's vocabulary comes
     from, so a chip cannot show an order the header would not produce. */
  ok('the builder draws the cluster rather than describing it',
    /actionsMini/.test(read('header-layouts.js')) && /L\.actionsMini\(/.test(B));
  const mini = H.actionsMini({ order: 'bag search account', words: false, account: true });
  ok('...in the order it is given',
    mini.indexOf('data-c="bag"') < mini.indexOf('data-c="search"')
    && mini.indexOf('data-c="search"') < mini.indexOf('data-c="account"'));
  ok('...and drops the account control when it lives in the bag',
    H.actionsMini({ order: 'search account bag', account: false }).indexOf('data-c="account"') < 0,
    'a card that shows a control the header will not is a card that lies');
  ok('...and shows words as words',
    /SEARCH|Search/.test(H.actionsMini({ order: 'search account bag', words: true, account: true })));

  ok('it can be dragged AND stepped with the arrows',
    /draggable="true"/.test(B) && /data-mv="-1"/.test(B) && /function moveHdrCtl\(/.test(B),
    'a control reachable only by a mouse gesture is a control some people cannot reach');
}

/* ── 6c · a row can live in the header instead ───────────────────────────── */
{
  console.log('\n  moving a row out of the panel');

  /* The panel could hide a row and nothing else, so "hide Orders" and "put
     Orders in the header" were the same button and only one of them existed. */
  ok('a row says which surface it is on',
    /var where = \(r\.where === 'header' && CAN_PROMOTE\[key\]\) \? 'header' : 'bag';/.test(FEAT)
    && /function setBagRowWhere\(key,where\)\{/.test(B));
  /* A stray where-value on a row nothing can build a control for would strand it:
     the panel stops drawing it, and nothing in the header draws it either. */
  ok('...and a row that cannot be built is never treated as promoted',
    /var CAN_PROMOTE = \{ orders: 1, saves: 1, support: 1 \};/.test(FEAT));
  ok('...and the three that need a control built for them get one',
    /var HDR_ROWS = \[/.test(FEAT)
    && ['orders', 'saves', 'support'].every((k) => new RegExp("key: '" + k + "'").test(FEAT)));
  /* The account is promotable too, and needs no injected control: the header
     already has one that reads the customer's name. Building a second anchor to
     the same page would put two account controls in the row and give the word
     account two meanings in the order, which can only place one of them. */
  ok('...while the account uses the control the header already has',
    !/key: 'account'/.test(FEAT) && /function accountInHeader\(\)/.test(FEAT));
  ok('...and leaves the panel when it does, rather than appearing twice',
    /rAccount\.enabled && !accountInHeader\(\)/.test(FEAT));
  /* The heading is not a link. Offering to move it would be offering a switch
     with nowhere to go. */
  ok('...but the heading cannot, and says so instead of offering a dead switch',
    /const movable=key!=='name';/.test(B) && /nowhere to go in the header/.test(B));

  /* MEASURED, and it was wrong: the row appeared in the header and stayed in
     the panel, which makes "move" mean "duplicate" — two routes to one page,
     one of them in the menu the shopper opened looking for it. */
  ok('a promoted row LEAVES the panel',
    /var here = function \(r\) \{ return r\.enabled && r\.where !== 'header'; \};/.test(FEAT)
    && /here\(rOrders\)/.test(FEAT) && /here\(rSupport\)/.test(FEAT));

  /* Also measured, also wrong: promoted rows ignored the order entirely,
     because this file runs when the BAG config lands and the order comes from
     the HEADER row — a different fetch, and whichever was second had nobody
     waiting for it. */
  ok('the order is re-applied whenever its attribute lands',
    /function watchActionOrder\(\)/.test(FEAT) && /attributeFilter: \['data-zw-hdr-order'\]/.test(FEAT),
    'two fetches, and picking an order to run them in would only move the race');
  ok('...and every validator on the way knows the promotable names',
    ['theme-engine.js', 'functions/_middleware.js', 'scripts/stamp-header-layout.js']
      .every((f) => /orders\|saves\|support/.test(read(f))),
    'one that did not silently dropped the whole order');

  /* One host resolver, because the search button already proved what a second
     copy does: it handled .nav-right only, so the icon never appeared on the
     eight .zw-hdr-group pages. */
  ok('new controls find their host through one function, not a second copy',
    /function actionsSlot\(\)/.test(FEAT)
    && (FEAT.match(/\.querySelector\('\.zw-hdr-group'\)/g) || []).length === 1);
  ok('a promoted row follows the words-or-glyphs setting like everything else',
    /\.zwf-hdr-row/.test(read('storefront-cohesion.css')),
    'a control that ignored it would be the one thing on the row reading differently');

  /* ── THE LABEL IS RENDERED THROUGH ::before, AND SO WAS THE THING KILLING IT
     The search launcher borrows a class whose ::before masks in a person glyph,
     so a rule kills that pseudo-element. Unscoped, it also killed the LABEL:
     with words on, the search control rendered nothing at all — present, sized,
     clickable and invisible — while the bag beside it read "BAG", because
     #cart-btn has no such rule. One control vanishing and its neighbour not is
     what made it look like a missing button rather than a hidden label.

     There are TWO copies of that rule, one in the stylesheet and one in the
     runtime-injected CSS, and scoping only the first left the fault exactly
     where it was. Both are checked here for that reason. */
  for (const [what, src] of [['the stylesheet', read('storefront-cohesion.css')],
                             ['the injected CSS', FEAT]]) {
    const kills = [...src.matchAll(/([^\n{]*\.zwf-search-btn(?:[^\n{]*)?::before[^{]*)\{[^}]*content\s*:\s*none/g)]
      .map((m) => m[1]);
    ok('  ' + what + ' kills the search ::before only while it is a glyph',
      kills.length > 0 && kills.every((sel) => /data-zw-iconlabels/.test(sel)),
      kills.filter((sel) => !/data-zw-iconlabels/.test(sel)).join(' | ') || 'no rule found');
  }
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

  /* A device viewer in the modal, and deliberately NOT a second device setting:
     it sets pvMode, which is the toolbar's own control, so there is one answer
     to "which device am I looking at" rather than two that can disagree. */
  ok('both tabs carry a device viewer',
    /id="hdrDvMob"/.test(B) && /id="hdrDvTab"/.test(B) && /id="hdrDvDesk"/.test(B)
    && /onclick="setPvMode\('mob'\)"/.test(B));
  ok('...and the tiles are drawn for the device you are viewing',
    /L\.miniature\(l, hdrDevice\(\)\)/.test(B)
    && /function hdrDevice\(\)\{ return \{mob:'phone',tab:'tablet',desk:'desktop'\}/.test(B));
  /* And the small tile is the header a phone REALLY gets, not a guess: the
     categories are display:none below 900 and the menu button appears. */
  ok('a phone tile shows the compact header, categories and all layouts alike',
    /function smallMini\(\)/.test(SRC)
    && /device === 'phone' \|\| device === 'tablet'\) return smallMini\(\)/.test(SRC));
  ok('...which is what the stylesheet actually does at that width',
    /@media \(max-width:900px\)\{ \.nav-center\{ display:none !important; \} \}/.test(read('storefront-cohesion.css')),
    'if this ever stops being true the tile starts lying about phones');

  /* The other two are whole-site questions, and saying so is what stops them
     growing per-device controls nobody would vary. */
  ok('the divider rule is outside the placement media query, so a phone shows it',
    /^html\[data-zw-hdr-lines="off"\]/m.test(read('storefront-cohesion.css')));
  ok('...and the modal says the non-placement answers apply at every width',
    /apply at every width/.test(B));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
if (fail) process.exit(1);
