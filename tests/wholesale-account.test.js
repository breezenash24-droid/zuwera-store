/* A wholesale account the resolver actually understands.
 *
 * Wholesale is two files that have to agree about one JSON object.
 * admin-wholesale.js WRITES profiles.wholesale; _price-resolution.js READS it
 * and decides from it whether this buyer is in the wholesale customer group and
 * what their order minimum is. Neither imports a schema from the other — they
 * agree by both being written correctly, which is the kind of agreement that
 * stops being true without anybody noticing.
 *
 * So the round trip is the test: build the object the admin page would save,
 * hand it to the resolver, and ask what the resolver makes of it. A status
 * string the writer allows and the reader has never heard of reads as "not
 * approved" — no error, no log, just a trade buyer paying full price.
 *
 * The other half is the money. The form collects DOLLARS and the cart compares
 * CENTS; a minimum stored in the wrong unit is a $250 floor that turns away a
 * $25,000 order, and it fails silently in the direction that loses the sale.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

(async () => {
  const W = await import('file://' + path.join(ROOT, 'functions', 'api', 'admin-wholesale.js').replace(/\\/g, '/'));
  const R = await import('file://' + path.join(ROOT, 'functions', 'api', '_price-resolution.js').replace(/\\/g, '/'));

  const { buildWholesale, minimumCents, STATUSES, TERMS } = W;
  const { isWholesaleBuyer, wholesaleMinimumCents, shopperFor, listApplies } = R;

  /* What the resolver would make of an object the admin page just saved. */
  const asProfile = (wholesale) => ({ id: 'x', wholesale });

  console.log('\n  a wholesale account the resolver understands\n');

  console.log('  only approved reaches the group');
  {
    const approved = buildWholesale({ status: 'approved', minOrder: '250' }, null, 'me@x.com');
    ok('approved is in the group', isWholesaleBuyer(asProfile(approved)) === true);

    for (const s of ['applied', 'suspended']) {
      const built = buildWholesale({ status: s, minOrder: '250' }, null, 'me@x.com');
      ok('"' + s + '" is NOT in the group', isWholesaleBuyer(asProfile(built)) === false,
        'an application that priced at wholesale would be an open door');
    }

    /* The writer must never emit a status the reader has not heard of: that
       reads as "not approved" and looks exactly like a bug. */
    const junk = buildWholesale({ status: 'active', minOrder: '250' }, null, 'me@x.com');
    ok('an unrecognised status is not stored as given',
      STATUSES.includes(junk.status), 'got ' + junk.status);
    ok('…and it does not accidentally grant the group',
      isWholesaleBuyer(asProfile(junk)) === false);

    ok('every status the writer allows is one the reader handles',
      STATUSES.every((s) => {
        const b = buildWholesale({ status: s }, null, '');
        return isWholesaleBuyer(asProfile(b)) === (s === 'approved');
      }), STATUSES.join(','));
  }

  console.log('\n  the minimum survives the trip in the right unit');
  {
    ok('dollars become cents', minimumCents('250') === 25000, String(minimumCents('250')));
    ok('decimals are not lost', minimumCents('249.99') === 24999, String(minimumCents('249.99')));
    ok('blank means no minimum', minimumCents('') === 0 && minimumCents(null) === 0);
    ok('a negative minimum is refused, not stored', minimumCents('-100') === 0);
    ok('nonsense is refused', minimumCents('abc') === 0);

    /* The figure the cart will actually enforce, read through the resolver. */
    const approved = buildWholesale({ status: 'approved', minOrder: '250' }, null, '');
    ok('the resolver reads back the same $250',
      wholesaleMinimumCents(asProfile(approved)) === 25000,
      String(wholesaleMinimumCents(asProfile(approved))));

    /* A minimum on an unapproved account is stored but not enforced — the admin
       page shows both figures precisely because these differ. */
    const applied = buildWholesale({ status: 'applied', minOrder: '250' }, null, '');
    ok('it is stored on an application', applied.min_order_cents === 25000);
    ok('…but not enforced there', wholesaleMinimumCents(asProfile(applied)) === 0,
      'a minimum on a buyer who is not in the group would refuse ordinary orders');
  }

  console.log('\n  the grant is recorded once and not rewritten');
  {
    const first = buildWholesale({ status: 'approved' }, null, 'alice@x.com');
    ok('approving stamps who and when', !!first.approved_at && first.approved_by === 'alice@x.com');

    const again = buildWholesale({ status: 'approved', company: 'Acme' }, first, 'bob@x.com');
    ok('re-saving keeps the original date', again.approved_at === first.approved_at,
      'editing a company name must not move the date the account was granted');
    ok('…and the original approver', again.approved_by === 'alice@x.com',
      'got ' + again.approved_by);

    const suspended = buildWholesale({ status: 'suspended' }, first, 'bob@x.com');
    ok('suspending keeps the record of the grant', suspended.approved_at === first.approved_at);
    const restored = buildWholesale({ status: 'approved' }, suspended, 'bob@x.com');
    ok('lifting a suspension does not re-grant it', restored.approved_at === first.approved_at,
      'the account was granted once');
  }

  console.log('\n  revoking is the absence of an account, not a status');
  {
    ok('no object means an ordinary customer', isWholesaleBuyer(asProfile(null)) === false);
    ok('…and no minimum', wholesaleMinimumCents(asProfile(null)) === 0);
    ok('a non-object is not a wholesale account', isWholesaleBuyer(asProfile('approved')) === false,
      'a bare string must not be read as a granted account');
  }

  console.log('\n  terms are recorded, and only the four that exist');
  {
    ok('a known term is kept', buildWholesale({ status: 'applied', terms: 'net30' }, null, '').terms === 'net30');
    ok('an unknown term falls back to prepaid',
      buildWholesale({ status: 'applied', terms: 'net90' }, null, '').terms === 'prepaid',
      'a term nothing understands would read as credit nobody extended');
    ok('the list is the four the page offers', TERMS.join(',') === 'prepaid,net15,net30,net60', TERMS.join(','));
  }

  console.log('\n  an approved buyer reaches a wholesale price list');
  {
    /* The last link: the group the resolver builds has to match the list the
       admin page creates. These are two different strings in two files, and if
       they ever differ the buyer is approved, the list exists, and the price
       still never changes. */
    const approved = buildWholesale({ status: 'approved' }, null, '');
    const shopper = shopperFor({
      isMember: false,
      isWholesale: isWholesaleBuyer(asProfile(approved)),
      region: 'US', channel: 'web',
    });
    const list = { customer_group: 'wholesale', active: true };
    ok('the group the resolver builds matches the list the page creates',
      listApplies(list, shopper) === true, JSON.stringify(shopper));

    const guest = shopperFor({ isMember: false, isWholesale: false });
    ok('and a guest does not match it', listApplies(list, guest) === false);

    /* The accident the endpoint checks for: a list called "Wholesale" with no
       customer_group applies to EVERYONE, which would put the trade price in
       front of every shopper. */
    ok('a list with no customer group would apply to everybody',
      listApplies({ name: 'Wholesale', active: true }, guest) === true,
      'this is why the endpoint matches on customer_group, not on the name');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
