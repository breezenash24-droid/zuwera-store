/* Where the store ships from — one address, four consumers.
 *
 * It was called SHIPPO_FROM_* because Shippo asked for it first, which made a
 * business address look like a courier's setting. The tax adapters then had to
 * read a variable named after a shipping provider to find out which state the
 * store sells from, and a store not using Shippo at all still had to fill in
 * Shippo's fields.
 *
 * Renamed to SHIP_FROM_* — not plain FROM_*, because the set includes an email
 * address and the store already has EMAIL_FROM (who customer mail is sent FROM).
 * FROM_EMAIL beside EMAIL_FROM is how a support address ends up on a parcel.
 *
 * The property these tests exist for is the boring one:
 * the old names must keep working, because an environment that has not been
 * migrated yet must not stop buying shipping labels. A rename that requires
 * every deployment to update its variables BEFORE the next deploy is a rename
 * that takes the store down.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

(async () => {
  const { pathToFileURL } = require('url');
  const { shipFrom, shipFromValue, shipFromKeys, shipFromIsComplete, SHIP_FROM_FIELDS } =
    await import(pathToFileURL(ROOT + '/functions/api/_ship-from.js').href);

  console.log('\n  ship-from address\n');

  console.log('  the new names');
  {
    const env = { SHIP_FROM_STREET1: '2930 Short Vine St', SHIP_FROM_CITY: 'Cincinnati', SHIP_FROM_STATE: 'OH', SHIP_FROM_ZIP: '45219' };
    const a = shipFrom(env);
    ok('reads SHIP_FROM_*', a.city === 'Cincinnati' && a.state === 'OH' && a.zip === '45219', JSON.stringify(a));
    ok('defaults the country rather than sending blank', a.country === 'US');
    ok('…and the sender name', !!a.name);
  }

  console.log('\n  the old names still work');
  {
    /* THE test. This is what an un-migrated Cloudflare environment looks like,
       and it must behave exactly as it did before the rename. */
    const env = {
      SHIPPO_FROM_STREET1: '2930 Short Vine St', SHIPPO_FROM_CITY: 'Cincinnati',
      SHIPPO_FROM_STATE: 'OH', SHIPPO_FROM_ZIP: '45219', SHIPPO_FROM_PHONE: '+15135550101',
    };
    const a = shipFrom(env);
    ok('an environment with only SHIPPO_FROM_* still resolves',
      a.street1 === '2930 Short Vine St' && a.state === 'OH' && a.zip === '45219', JSON.stringify(a));
    ok('…including the fields only some providers need', a.phone === '+15135550101');
    ok('…and is complete enough to buy a label', shipFromIsComplete(a));
  }

  console.log('\n  when both are set');
  {
    const env = { SHIP_FROM_STATE: 'OH', FROM_STATE: 'KY', SHIPPO_FROM_STATE: 'IN' };
    ok('the preferred name wins over both older ones',
      shipFromValue('STATE', env) === 'OH', shipFromValue('STATE', env));
    ok('…and the interim name still beats the original',
      shipFromValue('STATE', { FROM_STATE: 'KY', SHIPPO_FROM_STATE: 'IN' }) === 'KY');
  }

  console.log('\n  the admin panel beats the environment');
  {
    /* The address is editable in the admin (Returns → return address). A value
       typed there has to win, or an admin corrects the address, sees it saved,
       and labels keep printing the old one. */
    const env = { SHIPPO_FROM_CITY: 'Cincinnati' };
    const cache = { SHIP_FROM_CITY: 'Covington' };
    ok('a saved setting overrides the env var', shipFromValue('CITY', env, cache) === 'Covington');
    ok('…and the legacy key does too', shipFromValue('CITY', env, { SHIPPO_FROM_CITY: 'Newport' }) === 'Newport');
  }

  console.log('\n  incomplete is incomplete for everyone');
  {
    /* The rate quote and the label purchase have to agree on what "usable"
       means. If the quote accepts an address the purchase then rejects, the
       checkout offers a shipping price that cannot be bought. */
    ok('a missing ZIP is not shippable', !shipFromIsComplete({ street1: 'a', city: 'b', state: 'OH' }));
    ok('a missing street is not shippable', !shipFromIsComplete({ city: 'b', state: 'OH', zip: '45219' }));
    ok('nothing at all is not shippable', !shipFromIsComplete(null));
    ok('street, city, state and ZIP is enough',
      shipFromIsComplete({ street1: 'a', city: 'b', state: 'OH', zip: '45219' }));
  }

  console.log('\n  nobody reads it a second way');
  {
    /* The reason this file exists. Four features needed one address and each
       reached for the raw env var, so two of them (fulfilment and the tax
       origin) silently ignored the admin panel entirely — the rate was quoted
       from one address and the label bought from another.

       Any NEW direct read of env.SHIPPO_FROM_* would reintroduce that, and it
       would look like it worked right up until someone edited the address. */
    const dir = ROOT + '/functions/api';
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') || f === '_ship-from.js' || f === '_settings.js') continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/env\.(SHIPPO_)?FROM_[A-Z0-9_]+/.test(src)) offenders.push(f);
    }
    ok('no endpoint reads the address straight off env any more', offenders.length === 0, offenders.join(', '));

    ok('every field offers all three spellings, preferred first',
      SHIP_FROM_FIELDS.every((f) => shipFromKeys(f).length === 3
        && shipFromKeys(f)[0] === 'SHIP_FROM_' + f
        && shipFromKeys(f)[2] === 'SHIPPO_FROM_' + f));

    /* Settings-backed keys must be allow-listed or the admin write is rejected. */
    const settings = fs.readFileSync(dir + '/_settings.js', 'utf8');
    ok('the new keys are writable from the admin',
      SHIP_FROM_FIELDS.every((f) => settings.includes("'SHIP_FROM_" + f + "'")));
    /* The near-miss that caused the rename: SHIP_FROM_EMAIL is the contact on a
       label, EMAIL_FROM is who customer mail is sent from. Both must exist, and
       they must stay distinct. */
    ok('the label contact and the email sender are separate settings',
      settings.includes("'SHIP_FROM_EMAIL'") && settings.includes("'EMAIL_FROM'"));
    ok('…and the old ones still are, so nothing already saved is orphaned',
      SHIP_FROM_FIELDS.every((f) => settings.includes("'SHIPPO_FROM_" + f + "'")));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
