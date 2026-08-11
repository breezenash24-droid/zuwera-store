/* The quick-add modal listed XS, S, L, XL, 2XL, M — M last, because it asked
   for `order=created_at.asc` and that row was written last. Creation order is
   not size order; it only looked right while nobody had re-added a size. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..') + '/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const w = {};
new Function('window', fs.readFileSync(ROOT + 'size-order.js', 'utf8')
  .replace("typeof window !== 'undefined' ? window : this", 'window'))(w);
const S = w.ZWSizeOrder;
const line = (a) => S.sort(a).join(',');

console.log('\n  letters go in size order');
{
  ok('the reported case', line(['XS','S','L','XL','2XL','M']) === 'XS,S,M,L,XL,2XL');
  ok('…however they were cased or spaced', line(['xl','  m','S']) === 'S,  m,xl');
  ok('XXL and 2XL are the same place', S.rank('XXL') === S.rank('2XL'));
  ok('…and 3XL comes after both', S.rank('3XL') > S.rank('2XL'));
  /* Read rather than listed, so a store selling 5XL needs no code change. */
  ok('a size nobody listed still sorts', S.rank('5XL') > S.rank('4XL'));
  ok('…from the small end too', S.rank('2XS') < S.rank('XS'));
}

console.log('\n  and everything else has a defined place');
{
  /* Pushing an unknown to the front would put it above the sizes people
     actually shop by. */
  ok('an unrecognised label goes last', line(['XL','Youth L','S']) === 'S,XL,Youth L');
  ok('numeric sizes keep clear of the letters', S.rank('32') > S.rank('3XL'),
    'a catalogue mixing both must not interleave them');
  ok('…and sort numerically', line(['32','9','10']) === '9,10,32');
  ok('One Size lands mid-range rather than nowhere', S.rank('One Size') !== null);
  ok('nothing is not a size', S.rank('') === null && S.rank(null) === null);
}

console.log('\n  the sort does not mutate what it was given');
{
  const src = ['XL', 'S', 'M'];
  S.sort(src);
  ok('the input array is untouched', src.join(',') === 'XL,S,M',
    'sorting in place has bitten this codebase before');
  ok('it can sort pairs by their first element',
    S.sort([['XL',1],['S',2]], (e) => e[0]).map((e) => e[0]).join(',') === 'S,XL');
}

console.log('\n  and the modal uses it');
{
  const col = fs.readFileSync(ROOT + 'drop001.html', 'utf8');
  ok('the collection page loads it', /<script src="size-order\.js\?v=[0-9a-f]+"><\/script>/.test(col));
  ok('…and sorts the entries with it', /window\.ZWSizeOrder\s*\n?\s*\?\s*window\.ZWSizeOrder\.sort\(entries/.test(col));
  /* The query still asks for created_at; the sort is what fixes it. Asserted
     so nobody "fixes" the ordering by changing the query and leaving two. */
  ok('…rather than trusting the query order', /order=created_at\.asc/.test(col));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
