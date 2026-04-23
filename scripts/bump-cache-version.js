const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = ['index.html', 'product.html', 'drop001.html'];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function write(file, content) {
  fs.writeFileSync(path.join(root, file), content);
}

function nextVersion(contents, pattern) {
  const versions = [...contents.matchAll(pattern)].map(match => Number(match[1])).filter(Number.isFinite);
  return (versions.length ? Math.max(...versions) : 0) + 1;
}

const combined = targets.map(read).join('\n') + '\n' + read('sw.js');
const nextCss = nextVersion(combined, /storefront-cohesion\.css\?v=(\d+)/g);
const nextMenu = nextVersion(combined, /mobile-menu\.js\?v=(\d+)/g);
const nextSw = nextVersion(combined, /sw\.js\?v=(\d+)/g);
const nextCache = nextVersion(read('sw.js'), /zuwera-v(\d+)/g);

for (const file of targets) {
  let content = read(file)
    .replace(/storefront-cohesion\.css\?v=\d+/g, `storefront-cohesion.css?v=${nextCss}`)
    .replace(/mobile-menu\.js\?v=\d+/g, `mobile-menu.js?v=${nextMenu}`);
  if (file === 'index.html') content = content.replace(/sw\.js\?v=\d+/g, `sw.js?v=${nextSw}`);
  write(file, content);
}

write('sw.js', read('sw.js').replace(/zuwera-v\d+/g, `zuwera-v${nextCache}`));

console.log(`Bumped storefront CSS to v${nextCss}, mobile menu JS to v${nextMenu}, service worker URL to v${nextSw}, cache to zuwera-v${nextCache}.`);
