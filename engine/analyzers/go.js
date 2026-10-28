import path from 'path';
import { maskSource, makeLineIndex, pairs, depthMap, ownerOf, unique } from './common.js';

/**
 * Go analyzer: imports (resolved through go.mod to package directories),
 * top-level symbols, and a call graph. Best-effort and regex-based.
 */

const KEYWORDS = new Set([
  'if', 'for', 'switch', 'select', 'return', 'func', 'go', 'defer', 'range', 'case', 'else',
  'chan', 'map', 'struct', 'interface', 'type', 'var', 'const', 'package', 'import',
]);
const BUILTINS = new Set([
  'len', 'cap', 'append', 'make', 'new', 'delete', 'copy', 'panic', 'recover', 'close', 'print',
  'println', 'complex', 'real', 'imag', 'min', 'max', 'clear',
  'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr', 'float32', 'float64', 'bool', 'byte', 'rune', 'any', 'error',
]);

const isUpper = (s) => /^[A-Z]/.test(s);

function resolveGoImport(spec, fromFile, ctx) {
  const mod = ctx.goModule;
  if (!mod || (spec !== mod && !spec.startsWith(`${mod}/`))) return [];
  const dir = path.join(ctx.root, spec.slice(mod.length));
  return (ctx.goDirIndex.get(dir) ?? []).filter(f => f !== fromFile);
}

export function analyzeGo(source, filePath, ctx) {
  const common = { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"], raw: ['`'] };
  const withStrings = maskSource(source, { ...common, keepStrings: true });
  const masked = maskSource(source, common);
  const lineOf = makeLineIndex(source);

  // ── imports ────────────────────────────────────────────────────────────────
  const rawImports = [];
  const imports = [];
  const addImport = (spec) => {
    rawImports.push(spec);
    imports.push(...resolveGoImport(spec, filePath, ctx));
  };
  for (const m of withStrings.matchAll(/^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm)) addImport(m[1]);
  for (const block of withStrings.matchAll(/^[ \t]*import[ \t]*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/(?:^|\n)[ \t]*(?:[\w.]+[ \t]+)?"([^"\n]+)"/g)) addImport(m[1]);
  }

  const braces = pairs(masked, '{', '}');
  const parens = pairs(masked, '(', ')');
  const depth = depthMap(masked);

  const symbols = [];
  const ranges = [];
  const declNames = new Set(); // offsets of declaration names, so they aren't counted as calls

  // ── functions and methods ──────────────────────────────────────────────────
  const funcRe = /^func[ \t]*(?:\(([^)]*)\)[ \t]*)?([A-Za-z_]\w*)[ \t]*(?:\[[^\]\n]*\])?[ \t]*\(/dgm;
  for (const m of masked.matchAll(funcRe)) {
    const [nameStart] = m.indices[2];
    declNames.add(nameStart);
    const name = m[2];
    const recv = m[1] ? m[1].trim().split(/\s+/).pop().replace(/^\*/, '').replace(/\[.*$/, '') : null;
    symbols.push({
      kind: 'function',
      name: recv ? `${recv}.${name}` : name,
      exported: isUpper(name),
      line: lineOf(m.index),
    });

    // Find the body: skip the parameter list and any result type, stopping at
    // the first `{` that isn't `struct{` / `interface{}`; a newline first means no body.
    const paramsOpen = m.index + m[0].length - 1;
    let k = (parens.get(paramsOpen) ?? paramsOpen) + 1;
    let open = -1;
    for (; k < masked.length; k++) {
      const c = masked[k];
      if (c === '(') { k = parens.get(k) ?? k; continue; }
      if (c === '\n') break;
      if (c === '{') {
        const before = masked.slice(Math.max(0, k - 12), k).trimEnd();
        if (/(?:struct|interface)$/.test(before)) { k = braces.get(k) ?? k; continue; }
        open = k;
        break;
      }
    }
    if (open >= 0 && braces.has(open)) ranges.push({ name, start: open, end: braces.get(open) });
  }

  // ── types, vars, consts ────────────────────────────────────────────────────
  for (const m of masked.matchAll(/^type[ \t]+([A-Za-z_]\w*)/gm)) {
    symbols.push({ kind: 'type', name: m[1], exported: isUpper(m[1]), line: lineOf(m.index) });
  }
  for (const m of masked.matchAll(/^(?:var|const)[ \t]+([A-Za-z_]\w*)/gm)) {
    if (m[1] !== '_') symbols.push({ kind: 'variable', name: m[1], exported: isUpper(m[1]), line: lineOf(m.index) });
  }
  // grouped declarations: var ( ... ) / const ( ... ) / type ( ... )
  for (const m of masked.matchAll(/^(var|const|type)[ \t]*\(/gm)) {
    const open = m.index + m[0].length - 1;
    const close = parens.get(open);
    if (close == null) continue;
    const body = masked.slice(open + 1, close);
    let pos = open + 1;
    for (const text of body.split('\n')) {
      const nm = /^[ \t]*([A-Za-z_]\w*)/.exec(text);
      if (nm && depth[pos] === depth[open] + 1 && nm[1] !== '_') {
        symbols.push({
          kind: m[1] === 'type' ? 'type' : 'variable',
          name: nm[1],
          exported: isUpper(nm[1]),
          line: lineOf(pos),
        });
      }
      pos += text.length + 1;
    }
  }

  // ── calls ──────────────────────────────────────────────────────────────────
  const calls = [];
  for (const m of masked.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*\(/g)) {
    const callee = m[1];
    if (KEYWORDS.has(callee) || BUILTINS.has(callee) || declNames.has(m.index)) continue;
    calls.push({ caller: ownerOf(ranges, m.index), callee, line: lineOf(m.index) });
  }

  return { rawImports, imports: unique(imports), symbols, calls };
}
