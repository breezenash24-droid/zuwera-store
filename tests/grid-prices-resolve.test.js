const fs=require('fs'),path=require('path');
const ROOT='c:/Users/Breez/Zuwera-Repository';
let pass=0,fail=0;
const ok=(n,c,e)=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(e?'  — '+e:''))}};
const vp=fs.readFileSync(path.join(ROOT,'variant-price.js'),'utf8');
const home=fs.readFileSync(path.join(ROOT,'storefront.js'),'utf8');
const coll=fs.readFileSync(path.join(ROOT,'drop001.html'),'utf8');
console.log('\n  the grids ask the same resolver as everything else\n');
ok('both card templates mark their price element',
  /class="pcard-price" data-zw-price-for=/.test(home) && /class="product-price" data-zw-price-for=/.test(coll));
ok('both call the one painter after rendering',
  /ZWVariantPrice\.paintCards\(grid\)/.test(home) && /ZWVariantPrice\.paintCards\(grid\)/.test(coll));
ok('there is one painter, not one per grid', (vp.match(/function paintCards/g)||[]).length===1);
ok('it leaves a price alone when the server has not answered', /if \(!known\(pid\)\) continue;/.test(vp),
  'a failed request must show the catalogue figure, not a blank');
ok('it consults the member-pricing switch', /memberPricingOn\(\)/.test(vp),
  'a store with member pricing off must never show a member number on a card');
ok('both grids load the resolver', /variant-price\.js/.test(fs.readFileSync(path.join(ROOT,'index.html'),'utf8')) && /variant-price\.js/.test(coll));
console.log('\n  '+pass+' passed, '+fail+' failed\n');
process.exit(fail?1:0);
