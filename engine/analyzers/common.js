/**
 * engine/analyzers/common.js
 *
 * Shared helpers for the non-JS source analyzers (python, go, java).
 *
 * acorn only parses JavaScript, so these analyzers work on a *masked* copy of
 * the source: comments and string literals are replaced by spaces (newlines
 * kept), which means offsets and line numbers line up with the original and
 * regexes can't be fooled by code-looking text inside strings or comments.
 * They are best-effort structural scanners, not full parsers.
 */

const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * maskSource(src, opts)
 *
 * @param {string} src
 * @param {object} opts
 * @param {string[]}   [opts.line]    line-comment openers, e.g. ['//'] or ['#']
 * @param {string[]}   [opts.block]   [open, close] block-comment delimiters
 * @param {string[]}   [opts.quotes]  single-line string delimiters (backslash escapes)
 * @param {string[]}   [opts.triple]  multi-line string delimiters, e.g. ['"""']
 * @param {string[]}   [opts.raw]     raw multi-line delimiters with no escapes, e.g. ['`']
 * @param {boolean}    [opts.keepStrings] keep string contents (comments are still masked)
 * @returns {string} same length as src
 */
export function maskSource(src, opts = {}) {
  const { line = [], block = null, quotes = [], triple = [], raw = [], keepStrings = false } = opts;
  const n = src.length;
  let out = '';
  let i = 0;
  const emitString = (text) => { out += keepStrings ? text : blank(text); };

  outer: while (i < n) {
    for (const lc of line) {
      if (src.startsWith(lc, i)) {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += blank(src.slice(i, j));
        i = j;
        continue outer;
      }
    }
    if (block && src.startsWith(block[0], i)) {
      const j = src.indexOf(block[1], i + block[0].length);
      const end = j < 0 ? n : j + block[1].length;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    for (const t of triple) {
      if (src.startsWith(t, i)) {
        const j = src.indexOf(t, i + t.length);
        const end = j < 0 ? n : j + t.length;
        emitString(src.slice(i, end));
        i = end;
        continue outer;
      }
    }
    const ch = src[i];
    if (raw.includes(ch)) {
      const j = src.indexOf(ch, i + 1);
      const end = j < 0 ? n : j + 1;
      emitString(src.slice(i, end));
      i = end;
      continue;
    }
    if (quotes.includes(ch)) {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      const end = Math.min(src[j] === ch ? j + 1 : j, n);
      emitString(src.slice(i, end));
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** offset → 1-based line number, via binary search over line starts. */
export function makeLineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * pairs(masked, open, close)
 * Matching delimiter map: open offset → close offset. Unbalanced openers are omitted.
 */
export function pairs(masked, open = '{', close = '}') {
  const map = new Map();
  const stack = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === open) stack.push(i);
    else if (c === close && stack.length) map.set(stack.pop(), i);
  }
  return map;
}

/** depth before each char, counting every kind of bracket: ( [ { */
export function depthMap(masked) {
  const depth = new Int32Array(masked.length + 1);
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
    depth[i] = d;
    if (c === '(' || c === '[' || c === '{') d++;
  }
  depth[masked.length] = d;
  return depth;
}

/**
 * Smallest function range containing `offset`, or '<module>'.
 * @param {{name:string,start:number,end:number}[]} ranges
 */
export function ownerOf(ranges, offset) {
  let best = null;
  let bestSize = Infinity;
  for (const r of ranges) {
    if (offset >= r.start && offset <= r.end && r.end - r.start < bestSize) {
      bestSize = r.end - r.start;
      best = r.name;
    }
  }
  return best ?? '<module>';
}

/** Collapse an import list to unique entries, keeping first-seen order. */
export const unique = (arr) => [...new Set(arr)];
