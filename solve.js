// A fast, dependency-free reimplementation of the makefun-site 1.0.0 build,
// written from its README and observed behaviour. run(input) takes one case
// { site, templates, files } and returns the same output tree (path -> text)
// the reference build returns, byte for byte.
//
// The pipeline, in order: sort the files; parse the templates (a template
// that does not parse is reported and left out); read front matter and drop
// refused or draft sources; assign permalinks with unique slugs; render each
// body's Markdown (resolving links, collecting broken ones); order the posts
// and group the tags; render every page, index, tag and tags page through its
// layout; lay the static files over the tree; write build-report.txt.
//
// Speed comes from avoiding per-character work: inline Markdown is scanned
// with indexOf jumps between markup characters and escapes whole plain runs
// at once, blocks are rendered straight from the line array with no token
// objects, templates are compiled once to small op arrays and rendered into
// one shared output array with a reusable loop-frame stack, slugs are cached
// per case, and each post's card is built once and shared.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const RESERVED_DIRS = ['posts', 'tags', 'page'];
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESC_MAP[c]);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const w = !(c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160
      || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233
      || c === 8239 || c === 8287 || c === 12288 || c === 65279);
    if (w && !inWord) n++;
    inWord = w;
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dirParts` of a source, or null when it climbs out of the root. */
function resolveRel(dirParts, rel) {
  const parts = dirParts.slice();
  let p = 0;
  for (;;) {
    const slash = rel.indexOf('/', p);
    const seg = slash === -1 ? rel.slice(p) : rel.slice(p, slash);
    if (seg !== '' && seg !== '.') {
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    if (slash === -1) break;
    p = slash + 1;
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Trim spaces and tabs at both ends of a line. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------- slugs

/** Slug cache for this case (reset at the start of every run: cases never share one). */
let slugCache = null;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let s = plain.replace(/[^A-Za-z0-9]+/g, '-');
  if (s.charCodeAt(0) === 45) s = s.slice(1);
  if (s.charCodeAt(s.length - 1) === 45) s = s.slice(0, -1);
  s = s.toLowerCase().slice(0, 64).replace(/-+$/, '');
  const out = s === '' ? 'untitled' : s;
  slugCache.set(text, out);
  return out;
}

/**
 * `slug` made unique against `st.taken` (and added to it): the first of
 * slug, slug-2, slug-3 ... not taken. `st.next` remembers, per base slug,
 * one past the last suffix handed out, so a repeat never rescans suffixes
 * already known taken (the taken set only grows, so none of them can free up).
 */
function uniqueSlug(slug, st) {
  if (!st.taken.has(slug)) {
    st.taken.add(slug);
    return slug;
  }
  let n = st.next.get(slug) || 2;
  let out;
  do {
    out = `${slug}-${n}`;
    n++;
  } while (st.taken.has(out));
  st.next.set(slug, n);
  st.taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function parseString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a real day from 1970-01-01 to 2099-12-31 (YYYY-MM-DD). */
function isDate(raw) {
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100
    + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** `[a, b, c]`, each name trimmed, none empty or holding `"`, `[` or `]`; `[]` is no tags. */
function parseTags(raw) {
  if (raw.length < 2 || raw[0] !== '[' || raw[raw.length - 1] !== ']') {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const parts = inner.split(',');
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const t = parts[k].trim();
    if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    out.push(t);
  }
  return { value: out };
}

function isLayoutName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return false;
  }
  return true;
}

function isSlugValue(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      prevDash = false;
      continue;
    }
    if (c === '-') {
      if (i === 0 || prevDash) return false;
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseString(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return isDate(raw)
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags':
      return parseTags(raw);
    case 'draft':
      return raw === 'true' ? { value: true }
        : raw === 'false' ? { value: false }
        : { error: 'key "draft": true or false' };
    case 'layout':
      return isLayoutName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  const pos = firstNl === -1 ? text.length : firstNl + 1;
  let p = pos;
  let closeAt = -1;
  let bodyAt = -1;
  while (p <= text.length) {
    if (text.startsWith('---\n', p)) {
      closeAt = p;
      bodyAt = p + 4;
      break;
    }
    if (p + 3 === text.length && text.startsWith('---', p)) {
      closeAt = p;
      bodyAt = text.length;
      break;
    }
    const nl = text.indexOf('\n', p);
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(pos, closeAt);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line[0] === '#') continue;
    let j = 0;
    while (j < line.length && ((line[j] >= 'a' && line[j] <= 'z') || line[j] === '_')) j++;
    if (j === 0 || line[j] !== ':') return { error: `line ${i + 2} is not "key: value"` };
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line[j + 1] === ' ') raw = line.slice(j + 2).replace(/[ \t]+$/, '');
    else return { error: `line ${i + 2} is not "key: value"` };
    const key = line.slice(0, j);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === '#') return headingOf(line) !== null;
  if (c === '`') return FENCE_OPEN.test(line);
  if (c === '-' || c === '*') return HR.test(line);
  if (c === ' ' || c === '\t') return BLANK.test(line);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href.
 *
 * Plain runs are found with indexOf jumps between the four characters that
 * can start markup (`\`, backtick, `*`, `[`) and escaped as one chunk, so a
 * long stretch of ordinary text costs a few C++ scans instead of a JS step
 * and an escape call per character. A character that turns out to be literal
 * (a lone backtick, an unmatched `**`, a `[` with no link after it) simply
 * stays inside the current plain run.
 */
function inlineText(s, link) {
  const n = s.length;
  if (n === 0) return '';
  let out = '';
  let start = 0;
  let p = 0;
  for (;;) {
    const a = s.indexOf('\\', p);
    const b = s.indexOf('`', p);
    const c = s.indexOf('*', p);
    const d = s.indexOf('[', p);
    let j = -1;
    if (a !== -1) j = a;
    if (b !== -1 && (j === -1 || b < j)) j = b;
    if (c !== -1 && (j === -1 || c < j)) j = c;
    if (d !== -1 && (j === -1 || d < j)) j = d;
    if (j === -1) {
      if (start < n) out += escapeHtml(s.slice(start));
      break;
    }
    const ch = s[j];
    if (ch === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > start) out += escapeHtml(s.slice(start, j));
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        start = j + 2;
        p = j + 2;
      } else {
        p = j + 1;
      }
      continue;
    }
    if (ch === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out += escapeHtml(s.slice(start, j));
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        start = k + 1;
        p = k + 1;
      } else {
        p = j + 1;
      }
      continue;
    }
    if (ch === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out += escapeHtml(s.slice(start, j));
          out += `<strong>${inlineText(s.slice(j + 2, k), link)}</strong>`;
          start = k + 2;
          p = k + 2;
        } else {
          p = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (j > start) out += escapeHtml(s.slice(start, j));
          out += `<em>${inlineText(s.slice(j + 1, k), link)}</em>`;
          start = k + 1;
          p = k + 1;
        } else {
          p = j + 1;
        }
      }
      continue;
    }
    // ch === '['
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (j > start) out += escapeHtml(s.slice(start, j));
      out += `<a href="${escapeHtml(link(target))}">${inlineText(s.slice(j + 1, k), link)}</a>`;
      start = m + 1;
      p = m + 1;
    } else {
      p = j + 1;
    }
  }
  return out;
}

/** One list block, consumed from `lines` at `start` (whose line already matched). */
function takeList(lines, start, isOrdered, first, link, blocks) {
  const marker = isOrdered ? ORDERED : BULLET;
  const items = [[trimST(isOrdered ? first[2] : first[1])]];
  let i = start + 1;
  while (i < lines.length) {
    const m = marker.exec(lines[i]);
    if (m !== null) {
      items.push([trimST(isOrdered ? m[2] : m[1])]);
      i++;
    } else if (CONTINUED.test(lines[i])) {
      items[items.length - 1].push(trimST(lines[i]));
      i++;
    } else break;
  }
  const num = isOrdered ? Number(first[1]) : 1;
  const tag = isOrdered ? 'ol' : 'ul';
  let html = isOrdered && num !== 1 ? `<ol start="${num}">\n` : `<${tag}>\n`;
  for (const parts of items) html += `<li>${inlineText(parts.join('\n'), link)}</li>\n`;
  html += `</${tag}>\n`;
  blocks.push(html);
  return i;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Blocks are rendered straight from the line array; no token objects.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const idState = { taken: new Set(), next: new Map() };
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c = line[0];
    if (c === ' ' || c === '\t') {
      if (BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c === '`') {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        let code = '';
        while (i < n && !FENCE_CLOSE.test(lines[i])) code += `${escapeHtml(lines[i++])}\n`;
        i++;
        const lang = fence[1];
        blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${code}</code></pre>\n`);
        continue;
      }
    } else if (c === '#') {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), idState);
        const html = inlineText(h.text, link);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c === '-' || c === '*') {
      if (HR.test(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      const b = BULLET.exec(line);
      if (b !== null) {
        i = takeList(lines, i, false, b, link, blocks);
        continue;
      }
    } else if (c === '>') {
      const q = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        q.push(trimST(l[1] === ' ' ? l.slice(2) : l.slice(1)));
      }
      const kept = q.filter((l) => l !== '');
      blocks.push(kept.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : `<blockquote>\n<p>${inlineText(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    } else if (c >= '0' && c <= '9') {
      const o = ORDERED.exec(line);
      if (o !== null) {
        i = takeList(lines, i, true, o, link, blocks);
        continue;
      }
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inlineText(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds: 0 text {t}, 1 var/raw {p, r}, 3 if {p, n, a, e}, 4 for {name, p, b}, 5 include {name}.
// A parse tree is an array of such nodes.

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') {
        toks.push({ t: 0, x: text });
        text = '';
      }
      toks.push({ t: raw ? 2 : 1, p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open))
      && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      toks.push({ t: 0, x: text });
      text = '';
    }
    toks.push({ t: 3, x: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') toks.push({ t: 0, x: text });
  return toks;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 9, b: [] };
  const stack = [root];
  let body = root.b;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) body.push({ k: 0, t: tok.x });
    else if (tok.t === 1 || tok.t === 2) body.push({ k: 1, p: tok.p, r: tok.t === 2 });
    else {
      const tag = tok.x;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 4, name: m[1], p: pathOf(name, m[2]), b: [] };
        body.push(node);
        stack.push(node);
        body = node.b;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 3, p: pathOf(name, m[2]), n: m[1] !== undefined, a: [], e: null };
        body.push(node);
        stack.push(node);
        body = node.a;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.e !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.e = [];
        body = top.e;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 3)) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const par = stack[stack.length - 1];
        body = par.k === 9 ? par.b : par.k === 4 ? par.b : (par.e ?? par.a);
      } else if ((m = INC_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  }
  return root.b;
}

/** The rest of `path` from value `v`: each next name an own property, or undefined. */
function stepPath(v, path, k) {
  for (; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** The value at `path` in the scope chain: its first name from the nearest frame holding it, then own properties. */
function lookup(frames, root, path) {
  const first = path[0];
  for (let i = frames.length - 1; i >= 0; i--) {
    const fr = frames[i];
    if (first === 'loop') return stepPath(fr.loop, path, 1);
    if (first === fr.name) return stepPath(fr.val, path, 1);
  }
  if (!Object.hasOwn(root, first)) return undefined;
  return stepPath(root[first], path, 1);
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`. `cx` holds the parsed templates, the live
 * loop-frame stack and one reusable frame object per nesting depth, so a
 * loop iteration allocates nothing.
 */
function renderNodes(nodes, cx, root, out, depth) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    switch (nd.k) {
      case 0:
        out.push(nd.t);
        break;
      case 1: {
        const v = textOf(lookup(cx.frames, root, nd.p));
        out.push(nd.r ? v : escapeHtml(v));
        break;
      }
      case 3: {
        const br = truthy(lookup(cx.frames, root, nd.p)) !== nd.n ? nd.a : nd.e;
        if (br !== null) renderNodes(br, cx, root, out, depth);
        break;
      }
      case 4: {
        const xs = lookup(cx.frames, root, nd.p);
        if (!Array.isArray(xs)) break;
        const d = cx.frames.length;
        let fr = cx.pool[d];
        if (fr === undefined) {
          fr = { name: '', val: undefined, loop: { index: 0, first: false, last: false, length: 0 } };
          cx.pool[d] = fr;
        }
        fr.name = nd.name;
        const lp = fr.loop;
        lp.length = xs.length;
        cx.frames.push(fr);
        for (let k = 0; k < xs.length; k++) {
          fr.val = xs[k];
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === xs.length - 1;
          renderNodes(nd.b, cx, root, out, depth);
        }
        cx.frames.pop();
        break;
      }
      case 5: {
        const t = cx.templates.get(nd.name);
        if (t === undefined || depth >= 8) break;
        if (cx.stable.has(nd.name) && depth + cx.stableDepth.get(nd.name) <= 7) {
          const hit = cx.stableCache.get(nd.name);
          if (hit !== undefined) {
            out.push(hit);
            break;
          }
          const tmp = [];
          renderNodes(t, cx, root, tmp, depth + 1);
          const s = tmp.join('');
          cx.stableCache.set(nd.name, s);
          out.push(s);
        } else {
          renderNodes(t, cx, root, out, depth + 1);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template stability
//
// A template is cacheable when its output is a pure function of `site`,
// `tags` and `recent` (the same objects in every render of a case): under
// empty bindings it reads no first segment but site/tags/recent, or a name
// bound by one of its own loops over such a source, and every template it
// includes (with the bindings in force there) is the same. A cycle, or a
// read of anything else (page, posts, pager, tag, an unbound name), makes it
// uncacheable. Loop variables named site/tags/recent anywhere would let a
// caller loop shadow those reads, so then nothing is cacheable at all.
// A cacheable template's output also only stops depending on include depth
// once its deepest nested include still expands, which `stableDepth` (its
// longest include chain) bounds; the renderer only caches a render whose
// depth leaves room for that whole chain.

const STABLE_ROOTS = new Set(['site', 'tags', 'recent']);

function stableFirst(first, bound) {
  return STABLE_ROOTS.has(first) || bound.has(first);
}

/** Whether `nodes` reads only stable values under `bound`, templates in `active` being on the current include path. */
function analyzeStable(templates, nodes, bound, active) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    switch (nd.k) {
      case 0:
        break;
      case 1:
        if (!stableFirst(nd.p[0], bound)) return false;
        break;
      case 3:
        if (!stableFirst(nd.p[0], bound)) return false;
        if (!analyzeStable(templates, nd.a, bound, active)) return false;
        if (nd.e !== null && !analyzeStable(templates, nd.e, bound, active)) return false;
        break;
      case 4: {
        if (!stableFirst(nd.p[0], bound)) return false;
        const inner = new Set(bound);
        inner.add(nd.name);
        inner.add('loop');
        if (!analyzeStable(templates, nd.b, inner, active)) return false;
        break;
      }
      case 5: {
        const t = templates.get(nd.name);
        if (t === undefined) break;
        if (active.has(nd.name)) return false;
        active.add(nd.name);
        const ok = analyzeStable(templates, t, bound, active);
        active.delete(nd.name);
        if (!ok) return false;
        break;
      }
    }
  }
  return true;
}

/** Every loop variable name used anywhere in `nodes`, into `out`. */
function collectLoopNames(nodes, out) {
  for (const nd of nodes) {
    if (nd.k === 4) {
      out.add(nd.name);
      collectLoopNames(nd.b, out);
    } else if (nd.k === 3) {
      collectLoopNames(nd.a, out);
      if (nd.e !== null) collectLoopNames(nd.e, out);
    }
  }
}

/** The longest include chain below `nodes` (0 when it includes nothing), or -1 when the chain cycles. */
function includeDepth(templates, nodes, active, memo) {
  let best = 0;
  for (const nd of nodes) {
    let child = null;
    if (nd.k === 5) child = nd;
    else if (nd.k === 3) {
      const a = includeDepth(templates, nd.a, active, memo);
      if (a === -1) return -1;
      const e = nd.e === null ? 0 : includeDepth(templates, nd.e, active, memo);
      if (e === -1) return -1;
      if (a > best) best = a;
      if (e > best) best = e;
      continue;
    } else if (nd.k === 4) {
      const b = includeDepth(templates, nd.b, active, memo);
      if (b === -1) return -1;
      if (b > best) best = b;
      continue;
    } else continue;
    const t = templates.get(child.name);
    if (t === undefined) continue;
    if (active.has(child.name)) return -1;
    let d = memo.get(child.name);
    if (d === undefined) {
      active.add(child.name);
      d = includeDepth(templates, t, active, memo);
      active.delete(child.name);
      if (d === -1) return -1;
      memo.set(child.name, d);
    }
    if (1 + d > best) best = 1 + d;
  }
  return best;
}

/** The templates whose render is a pure function of site/tags/recent, with each one's longest include chain. */
function stableTemplates(templates) {
  const loopNames = new Set();
  for (const nodes of templates.values()) collectLoopNames(nodes, loopNames);
  const stable = new Set();
  const depths = new Map();
  if (loopNames.has('site') || loopNames.has('tags') || loopNames.has('recent')) {
    return { stable, depths };
  }
  const memo = new Map();
  for (const [name, nodes] of templates) {
    if (!analyzeStable(templates, nodes, new Set(), new Set([name]))) continue;
    const d = includeDepth(templates, nodes, new Set([name]), memo);
    if (d === -1) continue;
    stable.add(name);
    depths.set(name, d);
  }
  return { stable, depths };
}

// ---------------------------------------------------------------- the build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A post's card, as lists show it. Built once per source and shared. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : {
  title: s.data.title,
  url: s.url,
  date: s.data.date ?? '',
  date_long: s.data.date === undefined ? '' : longDate(s.data.date),
});

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();

  // Templates, in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const output = {};
  const { stable, depths } = stableTemplates(templates);

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, then the generator's own directories, a post's date, the
  // layout and the draft flag, in that order; the first failure is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir = null;
    if (s.path.startsWith('tags/')) ownDir = 'tags';
    else if (s.path.startsWith('page/')) ownDir = 'page';
    if (ownDir !== null) {
      report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const dirStates = new Map();
  const stateOf = (dir) => {
    let st = dirStates.get(dir);
    if (st === undefined) {
      st = { taken: new Set(dir === '' ? RESERVED_DIRS : []), next: new Map() };
      dirStates.set(dir, st);
    }
    return st;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), stateOf(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved to the pages and static files
  // they name; a target naming neither is reported once and kept as written.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const srcDir = dirOf(s.path);
    const dirParts = srcDir === '' ? [] : srcDir.split('/');
    const srcPath = s.path;
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order; ordered by count of posts, most first, then by slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of (p.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Every source's card, built once.
  for (const s of kept) s.card = cardOf(s);

  // Layouts. One root-vars object per render shape, reused across pages:
  // each shape's keys are fixed, and only the varying field is rewritten.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const cx = { templates, frames: [], pool: [], stable, stableDepth: depths, stableCache: new Map() };
  const pageRoot = { site, tags: allTags, recent, page: null };
  const indexRoot = { site, tags: allTags, recent, posts: null, pager: null };
  const tagRoot = { site, tags: allTags, recent, tag: null };
  const tagsRoot = { site, tags: allTags, recent };
  const renderWith = (root, name) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    cx.frames.length = 0;
    renderNodes(nodes, cx, root, out, 0);
    return out.join('');
  };
  for (const s of kept) {
    pageRoot.page = pageOf(s);
    output[`${s.outDir}/index.html`] = renderWith(pageRoot, s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexRoot.posts = posts.slice((k - 1) * per, k * per).map((p) => p.card);
    indexRoot.pager = {
      number: k,
      total: pages,
      url: indexUrl(k),
      newer_url: k === 1 ? '' : indexUrl(k - 1),
      older_url: k === pages ? '' : indexUrl(k + 1),
    };
    const html = renderWith(indexRoot, 'index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    tagRoot.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) };
    const html = renderWith(tagRoot, 'tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderWith(tagsRoot, 'tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted in
  // code-unit order, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  lines.push(`built ${kept.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
