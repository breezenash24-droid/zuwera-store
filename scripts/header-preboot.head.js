/* The header, on the first frame it is painted.
 *
 * storefront-features.js decides which optional header controls a store has
 * switched on, and it is deferred — so without this the header renders, then
 * changes about half a second later: a search magnifier appears, the bag panel
 * class lands. Small, and exactly the kind of movement that makes a storefront
 * feel unfinished on every single navigation.
 *
 * The answer is cached in localStorage by storefront-features.js on every load
 * (zw_srch, zw_bp), so this block can paint the same header the module would,
 * before the module exists.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * It was inline on index.html and product.html and absent from the other eight
 * pages — and the copy it had only knew one of the two header dialects, so
 * pasting it into those eight would have done nothing anyway.
 *
 * Placement is a marker rather than a habit because the ordering here is load
 * bearing and invisible when wrong: this block MUST sit after the header
 * markup. A copy placed above it finds nothing, inserts nothing, and throws
 * nothing — it just silently stops being a feature.
 * tests/header-preboot.test.js asserts the order on every page rather than
 * trusting whoever pastes it next. Being early is not the goal; being before
 * the first paint of the header is, and the parser cannot paint a header it has
 * not read.
 *
 * ── THE BAG-PANEL CLASS IS SET IN TWO PLACES, ON PURPOSE ─────────────────────
 *
 * body.zwf-bagpanel-on hides #login-btn / #account-btn / #hdr-login, which are
 * IN the header — so to beat their paint it wants to run BEFORE the header,
 * which is the opposite of what the search button needs. Five pages carry a
 * one-line block in <head> that does exactly that, and it stays.
 * Setting it here too is not a second answer to the same question: classList
 * .add is idempotent, and on the five pages that have no early copy this is the
 * difference between the class landing late and never landing at all.
 *
 * ── FIVE NAV DIALECTS, TWO BUTTON SYSTEMS ────────────────────────────────────
 *
 * There is no single header markup. Browse pages use `.nav-right` with `.nbtn`
 * children and a `#cart-btn`; information pages use `.zw-hdr-group` with
 * `.zw-hdr-action` children and a `.zw-hdr-bag`. A selector written against one
 * silently does nothing on the other — which is how the old copy could look
 * correct on the page it was written for and reach none of the rest.
 *
 * Both are handled here, once, and the class name comes from whichever host was
 * found so the button inherits that dialect's styling instead of arriving
 * unstyled.
 */
(function () {
  try {
    /* The bag panel is a body class, so it needs nothing from the header and
       works wherever this runs. Default ON: '0' is the only value that turns it
       off, so a browser that has never heard of the setting gets the shipped
       behaviour rather than the absence of it. */
    if (localStorage.getItem('zw_bp') !== '0') document.body.classList.add('zwf-bagpanel-on');

    /* Where the account control lives is NOT read here, though it was for one
       revision and the reason is worth keeping. It qualifies the class above
       and hides a button that is IN the header — so like that class it has to
       land before the header is parsed, and this block runs after it. It is
       read in the <head> block instead, onto <html>, which is the only element
       that exists that early. See storefront-cohesion.css for why the
       stylesheet then accepts the answer on either element. */

    if (localStorage.getItem('zw_srch') !== '1') return;

    /* Dialect one: the browse header. Dialect two: the information header.
       Ordered, not merged — a page could in principle carry both, and the
       browse header is the one a shopper is looking at when it does. */
    var host = null, before = null, cls = '';
    var nr = document.querySelector('.nav-right');
    var ct = nr && nr.querySelector('#cart-btn');
    if (nr && ct) {
      host = nr; before = ct; cls = 'nbtn';
    } else {
      var g = document.querySelector('.zw-hdr-group');
      if (g) { host = g; before = g.querySelector('.zw-hdr-bag'); cls = 'zw-hdr-action'; }
    }
    if (!host) return;

    /* Already there means storefront-features.js has run and beaten us to it,
       which is normal on a warm cache. Inserting a second one would give the
       header two magnifiers. */
    if (host.querySelector('.zwf-search-btn')) return;

    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls + ' zwf-search-btn';
    b.setAttribute('aria-label', 'Search');
    /* Kept byte-identical to SEARCH_SVG in storefront-features.js, and pinned
       there by the deployment checklist. Two icons that differ by a stroke
       width flicker at the moment the module takes over — the one thing this
       block exists to prevent. */
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';

    /* Before the bag, which is where storefront-features.js puts it. If the bag
       is missing from this dialect, appending still lands it in the actions
       row rather than dropping it. */
    if (before) host.insertBefore(b, before); else host.appendChild(b);
  } catch (_) { /* a header that did not gain an icon is not worth an error */ }
}());
