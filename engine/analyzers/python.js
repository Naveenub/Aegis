import path from 'path';
import { maskSource, makeLineIndex, ownerOf, unique } from './common.js';

/**
 * Python analyzer: imports, top-level symbols, and a call graph.
 * Best-effort and regex-based (see common.js) — no Python needed on the host.
 */

const KEYWORDS = new Set([
  'if', 'elif', 'while', 'for', 'return', 'assert', 'not', 'and', 'or', 'in', 'is', 'lambda',
  'yield', 'await', 'except', 'with', 'del', 'raise', 'else', 'try', 'import', 'from', 'async',
  'class', 'def', 'global', 'nonlocal', 'print', 'match', 'case',
]);

function resolvePyModule(dotted, level, fromFile, ctx) {
  const parts = dotted ? dotted.split('.') : [];
  if (parts.length === 0) return null;

  let bases;
  if (level > 0) {
    let d = path.dirname(fromFile);
    for (let i = 1; i < level; i++) d = path.dirname(d);
    bases = [d];
  } else {
    bases = [ctx.root, path.join(ctx.root, 'src')];
  }

  for (const base of bases) {
    const p = path.join(base, ...parts);
    for (const cand of [`${p}.py`, path.join(p, '__init__.py')]) {
      if (ctx.fileSet.has(cand)) return cand;
    }
  }
  return null;
}

export function analyzePython(source, filePath, ctx) {
  const masked = maskSource(source, { line: ['#'], triple: ['"""', "'''"], quotes: ['"', "'"] });
  const lineOf = makeLineIndex(source);

  const rawImports = [];
  const imports = [];
  const addImport = (dotted, level) => {
    const abs = resolvePyModule(dotted, level, filePath, ctx);
    if (abs && abs !== filePath) imports.push(abs);
  };
  const clean = (s) => s.split(',').map(x => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);

  // import a.b, c as d
  for (const m of masked.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm)) {
    for (const mod of clean(m[1])) {
      rawImports.push(mod);
      addImport(mod, 0);
    }
  }
  // from .pkg import name  /  from . import a, b  /  from x import (a,\n b)
  for (const m of masked.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]*)/gm)) {
    const level = m[1].length;
    const mod = m[2];
    const names = clean(m[3].replace(/[()]/g, '')).filter(n => n !== '*');
    rawImports.push(`${m[1]}${mod}`);
    if (mod) {
      addImport(mod, level);
      for (const nm of names) addImport(`${mod}.${nm}`, level); // `from pkg import submodule`
    } else {
      for (const nm of names) addImport(nm, level);              // `from . import sibling`
    }
  }

  // ── symbols (top level) ────────────────────────────────────────────────────
  const allMatch = source.match(/^__all__\s*=\s*[[(]([^\])]*)[\])]/m);
  const allNames = allMatch ? new Set([...allMatch[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1])) : null;
  const isExported = (name) => (allNames ? allNames.has(name) : !name.startsWith('_'));

  const symbols = [];
  const lines = masked.split('\n');
  lines.forEach((text, idx) => {
    let m;
    if ((m = /^(?:async[ \t]+)?def[ \t]+(\w+)/.exec(text))) {
      symbols.push({ kind: 'function', name: m[1], exported: isExported(m[1]), line: idx + 1 });
    } else if ((m = /^class[ \t]+(\w+)/.exec(text))) {
      symbols.push({ kind: 'class', name: m[1], exported: isExported(m[1]), line: idx + 1 });
    } else if ((m = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)[ \t]*(lambda\b)?/.exec(text))) {
      symbols.push({
        kind: m[2] ? 'function' : 'variable',
        name: m[1],
        exported: isExported(m[1]) && !/^__\w+__$/.test(m[1]),
        line: idx + 1,
      });
    }
  });

  // ── function ranges (by indentation) for call attribution ─────────────────
  const indentOf = (t) => t.length - t.trimStart().length;
  const lineStart = [];
  let off = 0;
  for (const t of lines) { lineStart.push(off); off += t.length + 1; }

  const ranges = [];
  lines.forEach((text, idx) => {
    const m = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)/.exec(text);
    if (!m) return;
    const ind = m[1].length;
    let last = idx;
    for (let k = idx + 1; k < lines.length; k++) {
      if (lines[k].trim() === '') continue;
      if (indentOf(lines[k]) <= ind) break;
      last = k;
    }
    ranges.push({ name: m[2], start: lineStart[idx], end: lineStart[last] + lines[last].length });
  });

  // ── calls ──────────────────────────────────────────────────────────────────
  const calls = [];
  const callRe = /(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*\(/g;
  for (const m of masked.matchAll(callRe)) {
    const callee = m[1];
    if (KEYWORDS.has(callee)) continue;
    const lineBefore = masked.slice(masked.lastIndexOf('\n', m.index) + 1, m.index);
    if (/\b(?:def|class)[ \t]+$/.test(lineBefore)) continue; // declaration, not a call
    calls.push({ caller: ownerOf(ranges, m.index), callee, line: lineOf(m.index) });
  }

  return { rawImports, imports: unique(imports), symbols, calls };
}
