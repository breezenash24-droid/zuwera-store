/**
 * _admin-markup.js — a real parse of admin.html, shared by the tests that
 * reason about WHERE something sits.
 *
 * ── WHY A TOKENIZER AND NOT A REGEX ─────────────────────────────────────────
 *
 * Two regex passes over this file once disagreed with each other by 4,585 lines
 * about where #productFormModal ended, because `<div>` inside an attribute value
 * counted as a tag and `<div>` inside a <script> string counted twice. Any check
 * that answers "is X inside Y" has to actually parse, or it will confidently
 * answer wrong.
 *
 * This is deliberately small: enough of an HTML parser to get the tag stack
 * right, and nothing else. It tracks quoted attribute values, comments,
 * doctypes, void elements, self-closing syntax, and the two raw-text elements
 * (<script>, <style>) whose contents are not markup.
 *
 * It does NOT implement implied end tags, so a genuinely malformed document
 * reports as malformed rather than being silently repaired the way a browser
 * would repair it. That is the correct behaviour here: the browser's repair is
 * exactly what let 364 lines of settings page live inside a modal without ever
 * raising an error.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

const hasClass = (node, cls) => new RegExp('(^|\\s)' + cls + '(\\s|$)').test(node.cls || '');

/**
 * Parse an HTML file.
 *
 * @returns {{
 *   ids: Object,            id -> { chain, node, line }   FIRST occurrence
 *   duplicateIds: Array,    every id that appears more than once, with lines
 *   containers: Array,      every element, with its direct element children
 *   problems: Array,        unclosed / mismatched tags
 *   line: Function,         offset -> 1-based line number
 * }}
 */
function parseHtml(src) {
  const ids = {};
  const seen = {};
  const duplicateIds = [];
  const containers = [];
  const problems = [];
  const stack = [];
  let i = 0;

  /* Line numbers are wanted for a handful of nodes, not for all ~40,000 tags,
     so the offsets are collected first and resolved in one pass at the end.
     Slicing the source per tag turned a 200ms parse into 40 seconds. */
  const lineStarts = [0];
  for (let k = 0; k < src.length; k += 1) if (src[k] === '\n') lineStarts.push(k + 1);
  const line = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e === -1 ? src.length : e + 3; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e === -1 ? src.length : e + 1; continue; }

    const closing = src[lt + 1] === '/';
    let j = lt + (closing ? 2 : 1);
    let name = '';
    while (j < src.length && /[a-zA-Z0-9:-]/.test(src[j])) { name += src[j]; j += 1; }
    name = name.toLowerCase();
    if (!name) { i = lt + 1; continue; }

    /* Skip to the end of the tag, respecting quoted attribute values. This is
       the part the regex versions got wrong. */
    let selfClose = false;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      else if (c === '/' && src[j + 1] === '>') selfClose = true;
      j += 1;
    }
    const after = j + 1;
    const raw = src.slice(lt, after);
    const idm = /\sid\s*=\s*["']([^"']+)["']/.exec(raw);
    const clm = /\sclass\s*=\s*["']([^"']*)["']/.exec(raw);
    const node = { name, id: idm ? idm[1] : '', cls: clm ? clm[1] : '', at: lt };

    if (!closing) {
      /* Register with the parent BEFORE pushing, so `kids` is direct children
         only — the distinction the whole exercise turns on. */
      const parent = stack[stack.length - 1];
      if (parent) parent.kids.push(node);

      if (node.id) {
        if (seen[node.id]) {
          seen[node.id].push(lt);
          if (seen[node.id].length === 2) duplicateIds.push(node.id);
        } else {
          seen[node.id] = [lt];
          /* Void and self-closing elements never enter the stack, so their
             chain is the stack as it stands. <input id="…"> is an id like any
             other and has to be findable. */
          ids[node.id] = { chain: stack.slice(), node, at: lt };
        }
      }
    }

    if (closing) {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k -= 1;
      if (k === -1) {
        problems.push('line ' + line(lt) + ': </' + name + '> with nothing open');
      } else {
        for (let m = stack.length - 1; m > k; m -= 1) {
          problems.push('line ' + line(stack[m].at) + ': <' + stack[m].name
            + (stack[m].id ? ' id="' + stack[m].id + '"' : '') + '> never closed, '
            + 'closed implicitly by </' + name + '> on line ' + line(lt));
        }
        stack.length = k;
      }
    } else if (!selfClose && !VOID.has(name)) {
      node.kids = [];
      containers.push(node);
      stack.push(node);
    }

    if (!closing && RAW.has(name) && !selfClose) {
      const close = src.toLowerCase().indexOf('</' + name, after);
      if (close !== -1) { i = close; continue; }
    }
    i = after;
  }

  for (const s of stack) {
    problems.push('line ' + line(s.at) + ': <' + s.name + (s.id ? ' id="' + s.id + '"' : '')
      + '> is still open at end of file');
  }

  for (const id of duplicateIds) {
    ids[id] = ids[id] || {};
    ids[id].duplicateLines = seen[id].map(line);
  }

  return { ids, duplicateIds, duplicates: seen, containers, problems, line };
}

function readAdmin() {
  const src = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
  const doc = parseHtml(src);
  doc.src = src;

  /** Is #id a descendant of #ancestorId? */
  doc.isInside = (id, ancestorId) =>
    !!doc.ids[id] && !!doc.ids[id].chain && doc.ids[id].chain.some((n) => n.id === ancestorId);

  /** Is #id anywhere inside an element carrying `cls`? */
  doc.isInsideClass = (id, cls) =>
    !!doc.ids[id] && !!doc.ids[id].chain && doc.ids[id].chain.some((n) => hasClass(n, cls));

  /** A human answer to "well, where IS it then?" */
  doc.whereIs = (id) => {
    if (!doc.ids[id] || !doc.ids[id].chain) return 'not in the document at all';
    const named = doc.ids[id].chain.filter((n) => n.id).pop();
    return named ? 'it is inside #' + named.id : 'it is inside nothing with an id';
  };

  return doc;
}

module.exports = { parseHtml, readAdmin, hasClass, VOID, RAW, ROOT };
