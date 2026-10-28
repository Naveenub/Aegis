import { maskSource, makeLineIndex, pairs, ownerOf, unique } from './common.js';

/**
 * Java analyzer: imports (resolved to files in the repo), types and methods as
 * symbols, and a call graph. Best-effort and regex-based.
 */

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'throw', 'new', 'super',
  'this', 'else', 'do', 'try', 'case', 'assert', 'yield', 'instanceof',
]);

const MAX_WILDCARD_FILES = 50;

function resolveJavaClass(fqcn, ctx) {
  const parts = fqcn.split('.');
  const suffix = `/${parts.join('/')}.java`;
  const candidates = ctx.javaByName.get(`${parts[parts.length - 1]}.java`) ?? [];
  return candidates.find(f => f.endsWith(suffix)) ?? null;
}

function resolveJavaPackage(pkg, ctx) {
  const suffix = `/${pkg.split('.').join('/')}`;
  const out = [];
  for (const [dir, files] of ctx.javaByDir) {
    if (dir.endsWith(suffix)) out.push(...files);
    if (out.length >= MAX_WILDCARD_FILES) break;
  }
  return out.slice(0, MAX_WILDCARD_FILES);
}

export function analyzeJava(source, filePath, ctx) {
  const masked = maskSource(source, {
    line: ['//'], block: ['/*', '*/'], triple: ['"""'], quotes: ['"', "'"],
  });
  const lineOf = makeLineIndex(source);
  const braces = pairs(masked, '{', '}');

  // ── imports ────────────────────────────────────────────────────────────────
  const rawImports = [];
  const imports = [];
  for (const m of masked.matchAll(/^[ \t]*import[ \t]+(static[ \t]+)?([\w.]+?)(\.\*)?[ \t]*;/gm)) {
    const [, isStatic, name, wildcard] = m;
    rawImports.push(`${isStatic ? 'static ' : ''}${name}${wildcard ?? ''}`);
    let found = null;
    if (isStatic) {
      // import static pkg.Class.member;  /  import static pkg.Class.*;
      found = resolveJavaClass(wildcard ? name : name.split('.').slice(0, -1).join('.'), ctx);
    } else if (wildcard) {
      imports.push(...resolveJavaPackage(name, ctx));
      continue;
    } else {
      found = resolveJavaClass(name, ctx);
    }
    if (found && found !== filePath) imports.push(found);
  }

  // ── types ──────────────────────────────────────────────────────────────────
  const types = [];
  const typeRe = /(?<![\w$.@])(class|interface|enum|record|@interface)[ \t\r\n]+([A-Za-z_$][\w$]*)/g;
  for (const m of masked.matchAll(typeRe)) {
    const [, keyword, name] = m;
    const after = masked.slice(m.index + m[0].length).trimStart();
    if (keyword === 'record' && !/^[(<]/.test(after)) continue; // `record` used as an identifier
    const open = masked.indexOf('{', m.index + m[0].length);
    if (open < 0 || !braces.has(open)) continue;
    const boundary = Math.max(
      masked.lastIndexOf(';', m.index), masked.lastIndexOf('{', m.index), masked.lastIndexOf('}', m.index),
    );
    types.push({
      name,
      kind: keyword === 'interface' || keyword === '@interface' ? 'type' : 'class',
      isInterface: keyword === 'interface' || keyword === '@interface',
      isPublic: /\bpublic\b/.test(masked.slice(boundary + 1, m.index)),
      line: lineOf(m.index),
      open,
      close: braces.get(open),
    });
  }
  // Qualify nested names: Outer.Inner
  for (const t of types) {
    const outers = types.filter(o => o !== t && o.open < t.open && o.close > t.close)
      .sort((a, b) => a.open - b.open);
    t.qualified = [...outers.map(o => o.name), t.name].join('.');
    t.topLevel = outers.length === 0;
  }

  const symbols = types.map(t => ({
    kind: t.kind, name: t.qualified, exported: t.isPublic, line: t.line,
  }));

  // ── members: walk each type body at member depth ──────────────────────────
  const ranges = [];
  const declNames = new Set();

  for (const t of types) {
    let segStart = t.open + 1;
    for (let i = t.open + 1; i < t.close; i++) {
      const c = masked[i];
      if (c !== '{' && c !== ';') continue;

      const header = masked.slice(segStart, i);
      const bodyEnd = c === '{' ? (braces.get(i) ?? i) : i;
      segStart = bodyEnd + 1;

      const stripped = header.replace(/@\w+(?:\.\w+)*(?:\([^)]*\))?/g, ' ');
      const paren = stripped.indexOf('(');
      const isMemberType = /\b(?:class|interface|enum|record)\b/.test(stripped.slice(0, paren < 0 ? undefined : paren));

      if (paren >= 0 && !isMemberType && /\)\s*(?:throws[\w$.,\s]+)?\s*$/.test(stripped)) {
        const nm = /([A-Za-z_$][\w$]*)\s*$/.exec(stripped.slice(0, paren));
        const before = nm ? stripped.slice(0, nm.index) : '';
        if (nm && !before.includes('=') && !KEYWORDS.has(nm[1])) {
          const isCtor = before.replace(/\b(?:public|protected|private)\b/g, '').trim() === '' && nm[1] === t.name;
          if (isCtor || before.trim() !== '') {
            const nameOffset = segStartOf(header, masked, i) + header.indexOf(nm[1], 0);
            declNames.add(nameOffset);
            if (c === '{' && braces.has(i)) ranges.push({ name: nm[1], start: i, end: braces.get(i) });
            if (!isCtor) {
              symbols.push({
                kind: 'function',
                name: `${t.qualified}.${nm[1]}`,
                exported: (/\bpublic\b/.test(header) || t.isInterface) && !/\bprivate\b/.test(header),
                line: lineOf(nameOffset),
              });
            }
          }
        }
      }
      if (c === '{') i = bodyEnd; // skip the member body (nested types get their own pass)
    }
  }

  // ── calls ──────────────────────────────────────────────────────────────────
  const calls = [];
  for (const m of masked.matchAll(/\bnew[ \t]+([\w$.]+)(?:<[^;(){}]*>)?[ \t]*\(/g)) {
    calls.push({ caller: ownerOf(ranges, m.index), callee: `new ${m[1]}`, line: lineOf(m.index) });
  }
  for (const m of masked.matchAll(/(?<![\w$.])(?<!new[ \t]+)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*\(/gd)) {
    const callee = m[1];
    if (KEYWORDS.has(callee) || declNames.has(m.indices[1][0])) continue;
    calls.push({ caller: ownerOf(ranges, m.index), callee, line: lineOf(m.index) });
  }

  return { rawImports, imports: unique(imports), symbols, calls };
}

// The member header string starts at some offset in `masked`; recover it by
// searching backwards from the terminating `{`/`;` so declaration names can be
// recorded by absolute offset.
function segStartOf(header, masked, endIdx) {
  return endIdx - header.length;
}
