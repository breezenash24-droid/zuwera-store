/* One deployment, one project.
 *
 * THE FAILURE THIS PREVENTS. The Supabase project ref was written out in 51
 * files — browser scripts, Workers, and a build script. Fine for one store, and
 * quietly disastrous for a second: a copy of this repository deployed as-is
 * gives you a storefront reading the ORIGINAL store's database, a build script
 * fetching the original store's fonts, and an admin migration panel pointed at
 * the original store's schema.
 *
 * The reason it needs a test rather than care is that the broken version WORKS.
 * Products load. The storefront renders. An admin signs in. Every symptom is
 * success, while a licensee's customers read and write somebody else's data.
 * There is no error to notice.
 *
 * The values are not secret — an anon key is public by design and RLS is the
 * real control. This is about ownership, not exposure.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

(async () => {
  const CANON = require(path.join(ROOT, 'zw-config.js'));
  const { pathToFileURL } = require('url');
  const worker = await import(pathToFileURL(ROOT + '/functions/api/_config.js').href);

  console.log('\n  project config\n');

  console.log('  there is a canonical definition');
  {
    ok('zw-config.js names the project', /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(CANON.supabaseUrl), CANON.supabaseUrl);
    ok('…and the anon key', typeof CANON.supabaseAnonKey === 'string' && CANON.supabaseAnonKey.startsWith('eyJ'));
    ok('…and the site URL', /^https:\/\//.test(CANON.siteUrl));
    ok('…and the brand name', !!CANON.brandName);
    ok('it loads in Node', typeof CANON === 'object');

    /* The UMD wrapper exists so build scripts can require() it and the browser
       can read it. Both halves must actually work or one consumer silently
       falls back to its own copy. */
    const src = fs.readFileSync(path.join(ROOT, 'zw-config.js'), 'utf8');
    ok('…and assigns a browser global too', /window\.ZW_CONFIG = config/.test(src));
  }

  console.log('\n  the Workers agree with it');
  {
    /* _config.js keeps its own copy because zw-config.js is UMD and a Worker is
       ESM with no `window` and no `module`. A copy is fine; a copy nobody
       compares is how the two drift and only one gets the next change. */
    ok('the Worker defaults match zw-config exactly',
      worker.DEFAULTS.supabaseUrl === CANON.supabaseUrl
      && worker.DEFAULTS.supabaseAnonKey === CANON.supabaseAnonKey
      && worker.DEFAULTS.siteUrl === CANON.siteUrl
      && worker.DEFAULTS.brandName === CANON.brandName,
      JSON.stringify({ worker: worker.DEFAULTS.supabaseUrl, canon: CANON.supabaseUrl }));

    /* Workers get real runtime configuration — they already receive `env`, so a
       licensee sets a dashboard variable and never edits code. */
    ok('env wins over the default',
      worker.supabaseUrl({ SUPABASE_URL: 'https://other.supabase.co' }) === 'https://other.supabase.co');
    ok('…under either name', worker.supabaseUrl({ ZW_SUPABASE_URL: 'https://z.supabase.co' }) === 'https://z.supabase.co');
    ok('…and falls back when unset', worker.supabaseUrl({}) === CANON.supabaseUrl);
    ok('a blank env var does not win', worker.supabaseUrl({ SUPABASE_URL: '   ' }) === CANON.supabaseUrl);
    ok('a trailing slash is trimmed, so callers can concatenate',
      worker.supabaseUrl({ SUPABASE_URL: 'https://x.supabase.co/' }) === 'https://x.supabase.co');
    ok('siteUrl resolves the same way', worker.siteUrl({ SITE_URL: 'https://s.example/' }) === 'https://s.example');
    ok('…and the anon key', worker.supabaseAnonKey({ SUPABASE_ANON_KEY: 'k' }) === 'k');
    ok('missing env entirely is survivable', worker.supabaseUrl(undefined) === CANON.supabaseUrl);
  }

  console.log('\n  no Worker keeps its own copy');
  {
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    }(path.join(ROOT, 'functions')));

    const ref = CANON.supabaseUrl.match(/https:\/\/([a-z0-9]+)\./)[1];
    const offenders = files
      .filter((f) => path.basename(f) !== '_config.js')
      .filter((f) => fs.readFileSync(f, 'utf8').includes(ref))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    ok(files.length + ' Workers checked; none writes the project ref itself',
      offenders.length === 0, offenders.join(', '));
  }

  console.log('\n  the browser files are rewritten at build time');
  {
    /* Browser code cannot resolve this at runtime: supabase.min.js is injected
       lazily, and announcement-bar.js and friends hit the REST API before it
       exists. Resolving from a global would mean every one of them awaiting it,
       and the first to forget reads undefined. So they carry a literal and the
       build rewrites it. */
    const stamp = fs.readFileSync(path.join(ROOT, 'scripts/stamp-project-config.js'), 'utf8');
    ok('the stamp exists', stamp.length > 500);
    ok('…and reads the canonical value rather than a second copy',
      /require\(path\.join\(ROOT, 'zw-config\.js'\)\)/.test(stamp));
    ok('…and rewrites the URL, the key and the site',
      /ZW_SUPABASE_URL/.test(stamp) && /ZW_SUPABASE_ANON_KEY/.test(stamp) && /ZW_SITE_URL/.test(stamp));
    ok('…and never touches functions/, which resolve from env instead',
      /SKIP_DIRS[\s\S]{0,160}'functions'/.test(stamp));

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('it runs on every build', /stamp-project-config\.js/.test(pkg.scripts.postinstall));
    /* Before the cache hasher, or the shipped file and its ?v= hash disagree
       and browsers serve a stale copy of the wrong project. */
    ok('…before the cache-version hasher',
      pkg.scripts.postinstall.indexOf('stamp-project-config') < pkg.scripts.postinstall.indexOf('bump-cache-version'));
    ok('…and before minification',
      pkg.scripts.postinstall.indexOf('stamp-project-config') < pkg.scripts.postinstall.indexOf('minify-inplace'));

    /* It has to actually reach every file that names the project, or the ones
       it misses keep talking to the original database. Run for real. */
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/stamp-project-config.js'), '--check'],
      { encoding: 'utf8', cwd: ROOT });
    const report = JSON.parse(out);
    const ref = CANON.supabaseUrl.match(/https:\/\/([a-z0-9]+)\./)[1];
    const unreachable = report.stillReferencing.filter((f) => !/^(zw-config\.js|functions\/)/.test(f));
    ok('every browser file naming the project is in the stamp\'s reach',
      report.files > 50 && report.stillReferencing.length > 0,
      'the stamp found ' + report.stillReferencing.length + ' file(s) to rewrite across ' + report.files);
    ok('…and the canonical files are the only ones excluded from rewriting',
      !report.stillReferencing.includes('functions/api/_config.js'),
      'Workers must not be stamped — they resolve from env');
  }

  console.log('\n  a build that would ship the wrong database fails');
  {
    /* The whole point. Shipping unconfigured is not a warning, because the
       result works perfectly while being wrong. */
    let exitCode = 0, stderr = '';
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/stamp-project-config.js')], {
        encoding: 'utf8', cwd: ROOT,
        env: { ...process.env, CF_PAGES: '1', ZW_SUPABASE_URL: '', ZW_SUPABASE_ANON_KEY: '', ZW_SITE_URL: '' },
      });
    } catch (e) {
      exitCode = e.status; stderr = (e.stderr || '') + (e.stdout || '');
    }
    ok('a Cloudflare build with no ZW_SUPABASE_URL stops', exitCode === 1, 'exit ' + exitCode);
    ok('…saying what to set', /ZW_SUPABASE_URL/.test(stderr) && /Build variables/.test(stderr));
    /* The distinction that cost a build cycle: Cloudflare keeps runtime
       variables and BUILD variables in two places, and postinstall only sees
       the second. The message has to say so, because the dashboard does not. */
    ok('…and WHERE, since runtime variables are invisible to a build',
      /Variables and Secrets/.test(stderr) && /runtime only/.test(stderr));
    ok('…and lists what the build could actually see, so a log ends the guessing',
      /Relevant variables this build CAN see/.test(stderr));
    ok('…and why it matters', /would appear to work/i.test(stderr));

    /* ── The build that is ALREADY right must not be refused ──────────────
       The original store sets the variables to its own project, so nothing
       needs rewriting and every file legitimately still names it. A first
       version treated that as "literals the stamp could not reach" and failed
       the one build that was correct — turning a guard against shipping the
       wrong database into a guard against shipping at all. */
    let sameExit = 0, sameOut = '';
    try {
      sameOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts/stamp-project-config.js')], {
        encoding: 'utf8', cwd: ROOT,
        env: { ...process.env, CF_PAGES: '1', ZW_SUPABASE_URL: CANON.supabaseUrl, ZW_SUPABASE_ANON_KEY: '', ZW_SITE_URL: '' },
      });
    } catch (e) { sameExit = e.status; sameOut = (e.stdout || '') + (e.stderr || ''); }
    ok('naming the project it already is, is a valid answer', sameExit === 0, sameOut.slice(0, 300));
    ok('…and rewrites nothing', /0 value\(s\) rewritten/.test(sameOut), sameOut.slice(0, 200));

    /* And the runtime names count, so a deployment that already has
       SUPABASE_URL configured does not have to invent a second variable
       holding the identical value — two names for one fact is how they end up
       disagreeing. */
    let aliasExit = 0;
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/stamp-project-config.js')], {
        encoding: 'utf8', cwd: ROOT,
        env: { ...process.env, CF_PAGES: '1', ZW_SUPABASE_URL: '', SUPABASE_URL: CANON.supabaseUrl },
      });
    } catch (e) { aliasExit = e.status; }
    ok('SUPABASE_URL is accepted as well as ZW_SUPABASE_URL', aliasExit === 0, 'exit ' + aliasExit);

    /* Local builds must stay silent — a developer with no env is not deploying
       anything and should not be blocked. */
    let localExit = 0;
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/stamp-project-config.js')], {
        encoding: 'utf8', cwd: ROOT, env: { ...process.env, CF_PAGES: '' },
      });
    } catch (e) { localExit = e.status; }
    ok('a local build is unaffected', localExit === 0, 'exit ' + localExit);
  }

  console.log('\n  the build script does not fetch from the wrong project either');
  {
    /* stamp-config-defaults.js pulls the live fonts to stamp first-paint CSS.
       It had its own hardcoded project, so a licensee's build would have
       fetched the ORIGINAL store's typography — surfacing as nothing worse than
       the wrong font for half a second, which nobody would trace back here. */
    const src = fs.readFileSync(path.join(ROOT, 'scripts/stamp-config-defaults.js'), 'utf8');
    const ref = CANON.supabaseUrl.match(/https:\/\/([a-z0-9]+)\./)[1];
    ok('it no longer names a project', !src.includes(ref));
    ok('…reading the canonical config instead', /require\(path\.join\(__dirname, '\.\.', 'zw-config\.js'\)\)/.test(src));
    ok('…with env taking precedence', /process\.env\.ZW_SUPABASE_URL \|\| process\.env\.SUPABASE_URL \|\| CANON\.supabaseUrl/.test(src));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
