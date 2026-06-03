/**
 * engine/repo-scanner.js
 *
 * File-system walk  +  AST-based semantic analysis.
 *
 * Previously this module only produced flat file listings — agents received
 * filenames and raw content with no understanding of code structure.
 *
 * Now it also builds:
 *   • a symbol table  (exported functions / classes / variables per file)
 *   • an import graph  (who imports whom, resolved to absolute paths)
 *   • a call graph     (which function calls which, scoped per file)
 *   • a dependency map (reverse of the import graph: who depends on each file)
 *
 * All analysis is best-effort: files that cannot be parsed (non-JS, syntax
 * errors, binary) are silently skipped so the walk never throws.
 *
 * Public API
 * ──────────
 *   scanRepo(root?)              → Promise<string[]>
 *   scanRepoSync(root?)          → string[]
 *   analyzeRepo(root?)           → Promise<RepoAnalysis>
 *   formatRepoContext(analysis)  → string   (compact agent-prompt string)
 */

import fs          from 'fs';
import fsPromises  from 'fs/promises';
import path        from 'path';
import { parse }   from 'acorn';

// ─── Constants ────────────────────────────────────────────────────────────────

const PRUNE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'coverage']);

/** File extensions we attempt to parse as JavaScript/ESM. */
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

/** Max bytes read for AST analysis (avoids parsing huge generated files). */
const PARSE_SIZE_LIMIT = 200_000;

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SymbolInfo
 * @property {'function'|'class'|'variable'|'type'} kind
 * @property {string}  name
 * @property {boolean} exported
 * @property {number}  line
 */

/**
 * @typedef {Object} CallSite
 * @property {string} caller   - function/method name (or '<module>' for top-level)
 * @property {string} callee   - called identifier
 * @property {number} line
 */

/**
 * @typedef {Object} FileAnalysis
 * @property {string}      filePath
 * @property {string[]}    imports        - resolved absolute paths this file imports
 * @property {string[]}    rawImports     - original specifiers (including unresolved)
 * @property {SymbolInfo[]} symbols
 * @property {CallSite[]}  calls
 * @property {string|null} parseError     - null if AST succeeded
 */

/**
 * @typedef {Object} RepoAnalysis
 * @property {string[]}                   files          - all file paths (full walk)
 * @property {Map<string, FileAnalysis>}  fileMap        - keyed by absolute path
 * @property {Map<string, string[]>}      importGraph    - file → files it imports
 * @property {Map<string, string[]>}      dependencyMap  - file → files that import it
 * @property {Map<string, SymbolInfo[]>}  symbolTable    - file → exported symbols
 */

// ─── Filesystem walk (unchanged contract) ────────────────────────────────────

/**
 * scanRepo(root?)
 * Async BFS directory walk. Returns absolute paths of all regular files,
 * excluding PRUNE_DIRS. Symlinks and exotic types are silently skipped.
 *
 * @param {string} [root]
 * @returns {Promise<string[]>}
 */
export async function scanRepo(root = process.cwd()) {
  const files = [];
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.shift();

    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (PRUNE_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  return files;
}

/**
 * scanRepoSync(root?)
 * Synchronous fallback used only by engine/test-runner.js inside a blocked
 * Docker sandbox context. All other callers must use scanRepo().
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function scanRepoSync(root = process.cwd()) {
  const files = [];
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.shift();

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (PRUNE_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  return files;
}

// ─── AST analysis helpers ─────────────────────────────────────────────────────

/**
 * Resolve an import specifier to an absolute path, or return null if it
 * cannot be resolved (external package, dynamic expression, etc.).
 *
 * @param {string} specifier
 * @param {string} fromFile   - absolute path of the importing file
 * @returns {string|null}
 */
function resolveSpecifier(specifier, fromFile) {
  // Only handle relative imports; skip bare specifiers (npm packages, node:*)
  if (!specifier.startsWith('.')) return null;

  const dir      = path.dirname(fromFile);
  const resolved = path.resolve(dir, specifier);

  // Try the specifier as-is, then with common JS extensions appended
  const candidates = [
    resolved,
    ...JS_EXTENSIONS.values().map ? [...JS_EXTENSIONS].map(ext => resolved + ext) : [],
    path.join(resolved, 'index.js'),
    path.join(resolved, 'index.mjs'),
  ];

  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.F_OK);
      return c;
    } catch {
      // not found — try next candidate
    }
  }

  return null;
}

/**
 * Walk an AST node tree using a simple visitor pattern.
 * Calls visitor(node) for every node where node.type matches any key in the
 * visitor map; no return value is used.
 *
 * @param {object}   node
 * @param {object}   visitors  - { NodeType: (node) => void }
 */
function walk(node, visitors) {
  if (!node || typeof node !== 'object') return;

  if (node.type && visitors[node.type]) {
    visitors[node.type](node);
  }

  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visitors);
    } else if (child && typeof child === 'object' && child.type) {
      walk(child, visitors);
    }
  }
}

/**
 * Extract the plain name from an expression node (Identifier, MemberExpression).
 * Returns null for computed or complex expressions.
 *
 * @param {object} node
 * @returns {string|null}
 */
function nameOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    const obj  = nameOf(node.object);
    const prop = nameOf(node.property);
    return obj && prop ? `${obj}.${prop}` : null;
  }
  return null;
}

/**
 * Analyse a single JS/TS file: extract imports, exported symbols, and calls.
 *
 * @param {string} filePath
 * @returns {FileAnalysis}
 */
function analyzeFile(filePath) {
  /** @type {FileAnalysis} */
  const result = {
    filePath,
    imports: [],
    rawImports: [],
    symbols: [],
    calls: [],
    parseError: null,
  };

  let source;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > PARSE_SIZE_LIMIT) {
      result.parseError = `file too large (${stat.size} bytes)`;
      return result;
    }
    source = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    result.parseError = `read error: ${err.message}`;
    return result;
  }

  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType:  'module',
      locations:   true,
      // TypeScript is not natively supported by acorn, so TS-specific syntax
      // will cause a parse error — caught below and recorded in parseError.
    });
  } catch (err) {
    // Try again as a CommonJS script (no import/export)
    try {
      ast = parse(source, {
        ecmaVersion: 'latest',
        sourceType:  'script',
        locations:   true,
      });
    } catch (err2) {
      result.parseError = err2.message;
      return result;
    }
  }

  // ── Track the current enclosing function name for call attribution ──────────
  // We use a simple stack: push on enter, pop on exit. The walk() helper is a
  // simple pre-order DFS and doesn't natively support exit callbacks, so we
  // handle the stack manually with a separate pass for call attribution.

  // ── Pass 1: imports ─────────────────────────────────────────────────────────
  walk(ast, {
    ImportDeclaration(node) {
      const spec = node.source.value;
      result.rawImports.push(spec);
      const abs = resolveSpecifier(spec, filePath);
      if (abs) result.imports.push(abs);
    },
    // Dynamic import()
    ImportExpression(node) {
      if (node.source.type === 'Literal') {
        const spec = node.source.value;
        result.rawImports.push(spec);
        const abs = resolveSpecifier(spec, filePath);
        if (abs) result.imports.push(abs);
      }
    },
    // CommonJS require()
    CallExpression(node) {
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments[0]?.type === 'Literal'
      ) {
        const spec = node.arguments[0].value;
        result.rawImports.push(spec);
        const abs = resolveSpecifier(spec, filePath);
        if (abs) result.imports.push(abs);
      }
    },
  });

  // ── Pass 2: exported symbols ─────────────────────────────────────────────────
  walk(ast, {
    ExportNamedDeclaration(node) {
      const decl = node.declaration;
      if (!decl) {
        // export { a, b as c }
        for (const spec of node.specifiers ?? []) {
          result.symbols.push({
            kind:     'variable',
            name:     spec.exported.name,
            exported: true,
            line:     spec.loc?.start.line ?? 0,
          });
        }
        return;
      }
      extractDeclSymbols(decl, result.symbols, true);
    },
    ExportDefaultDeclaration(node) {
      const decl = node.declaration;
      const name = (decl.id?.name) ?? 'default';
      result.symbols.push({
        kind:     declKind(decl),
        name,
        exported: true,
        line:     node.loc?.start.line ?? 0,
      });
    },
    // Also collect top-level non-exported declarations for the symbol table
    FunctionDeclaration(node) {
      if (node.id) {
        result.symbols.push({
          kind:     'function',
          name:     node.id.name,
          exported: false,
          line:     node.loc?.start.line ?? 0,
        });
      }
    },
    ClassDeclaration(node) {
      if (node.id) {
        result.symbols.push({
          kind:     'class',
          name:     node.id.name,
          exported: false,
          line:     node.loc?.start.line ?? 0,
        });
      }
    },
  });

  // Deduplicate symbols (export + declaration would produce two entries)
  const seen = new Set();
  result.symbols = result.symbols.filter(s => {
    const key = `${s.name}:${s.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Pass 3: call graph ───────────────────────────────────────────────────────
  // Build a map of function ranges so we can attribute each call site.
  const fnRanges = []; // [{ name, start, end }]

  walk(ast, {
    FunctionDeclaration(node) {
      if (node.id && node.start != null) {
        fnRanges.push({ name: node.id.name, start: node.start, end: node.end });
      }
    },
    FunctionExpression(node) {
      // Named function expressions: const foo = function bar() {}
      if (node.id && node.start != null) {
        fnRanges.push({ name: node.id.name, start: node.start, end: node.end });
      }
    },
    ArrowFunctionExpression(node) {
      // Arrow functions rarely have a name in the AST; skip for now.
    },
    MethodDefinition(node) {
      if (node.key?.type === 'Identifier' && node.value?.start != null) {
        fnRanges.push({
          name:  node.key.name,
          start: node.value.start,
          end:   node.value.end,
        });
      }
    },
  });

  /**
   * Find the innermost function that contains a given offset.
   * Returns '<module>' for top-level code.
   */
  function ownerOf(offset) {
    let best = null;
    let bestSize = Infinity;
    for (const r of fnRanges) {
      if (offset >= r.start && offset <= r.end) {
        const size = r.end - r.start;
        if (size < bestSize) {
          bestSize = size;
          best = r.name;
        }
      }
    }
    return best ?? '<module>';
  }

  walk(ast, {
    CallExpression(node) {
      const callee = nameOf(node.callee);
      if (!callee || callee === 'require') return; // skip require (already in imports)

      result.calls.push({
        caller: ownerOf(node.start),
        callee,
        line:   node.loc?.start.line ?? 0,
      });
    },
    NewExpression(node) {
      const callee = nameOf(node.callee);
      if (!callee) return;
      result.calls.push({
        caller: ownerOf(node.start),
        callee: `new ${callee}`,
        line:   node.loc?.start.line ?? 0,
      });
    },
  });

  return result;
}

/** Return a SymbolInfo kind from a declaration node. */
function declKind(decl) {
  if (!decl) return 'variable';
  switch (decl.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return 'function';
    case 'ClassDeclaration':
    case 'ClassExpression':
      return 'class';
    default:
      return 'variable';
  }
}

/** Extract symbols from a VariableDeclaration / FunctionDeclaration / ClassDeclaration. */
function extractDeclSymbols(decl, out, exported) {
  if (!decl) return;
  if (decl.type === 'VariableDeclaration') {
    for (const declarator of decl.declarations) {
      if (declarator.id.type === 'Identifier') {
        out.push({
          kind:     declKind(declarator.init),
          name:     declarator.id.name,
          exported,
          line:     declarator.loc?.start.line ?? 0,
        });
      }
    }
  } else if (decl.id) {
    out.push({
      kind:     declKind(decl),
      name:     decl.id.name,
      exported,
      line:     decl.loc?.start.line ?? 0,
    });
  }
}

// ─── Public: analyzeRepo ──────────────────────────────────────────────────────

/**
 * analyzeRepo(root?)
 *
 * Full semantic scan: walks the directory tree, parses every JS/TS file with
 * acorn, and returns a RepoAnalysis with symbol table, import graph, call
 * graph, and dependency map.
 *
 * Non-JS files are included in `files` but omitted from `fileMap` / graphs.
 * Files with parse errors are included with their `parseError` field set.
 *
 * @param {string} [root]
 * @returns {Promise<RepoAnalysis>}
 */
export async function analyzeRepo(root = process.cwd()) {
  const files = await scanRepo(root);

  /** @type {Map<string, FileAnalysis>} */
  const fileMap = new Map();
  /** @type {Map<string, string[]>}    */
  const importGraph   = new Map();
  /** @type {Map<string, string[]>}    */
  const dependencyMap = new Map();
  /** @type {Map<string, SymbolInfo[]>} */
  const symbolTable   = new Map();

  // Initialise dependency map keys for all known files upfront
  for (const f of files) dependencyMap.set(f, []);

  // Analyse JS/TS files concurrently (I/O bound — Promise.all is safe here)
  const jsFiles = files.filter(f => JS_EXTENSIONS.has(path.extname(f)));

  await Promise.all(
    jsFiles.map(async (filePath) => {
      // analyzeFile is synchronous (reads + parses); run in next microtask to
      // let other promises interleave on the event loop during heavy scans.
      await Promise.resolve();
      const analysis = analyzeFile(filePath);
      fileMap.set(filePath, analysis);
      importGraph.set(filePath, analysis.imports);
      symbolTable.set(filePath, analysis.symbols.filter(s => s.exported));
    })
  );

  // Build reverse dependency map
  for (const [importer, imported] of importGraph) {
    for (const dep of imported) {
      if (!dependencyMap.has(dep)) dependencyMap.set(dep, []);
      dependencyMap.get(dep).push(importer);
    }
  }

  return { files, fileMap, importGraph, dependencyMap, symbolTable };
}

// ─── Public: formatRepoContext ────────────────────────────────────────────────

/**
 * formatRepoContext(analysis, options?)
 *
 * Convert a RepoAnalysis into a compact human-readable string suitable for
 * injection into an agent system prompt.  Replaces the old plain file listing
 * with structured sections: file tree, symbol table, import graph, and call
 * graph highlights.
 *
 * @param {RepoAnalysis} analysis
 * @param {{ root?: string, maxCallsPerFile?: number }} [opts]
 * @returns {string}
 */
export function formatRepoContext(analysis, opts = {}) {
  const { root = process.cwd(), maxCallsPerFile = 15 } = opts;
  const rel = (p) => path.relative(root, p);

  const lines = [];

  // ── 1. File tree ─────────────────────────────────────────────────────────────
  lines.push('=== REPO FILE TREE ===');
  for (const f of analysis.files) {
    lines.push(`  ${rel(f)}`);
  }

  // ── 2. Exported symbol table ─────────────────────────────────────────────────
  lines.push('\n=== EXPORTED SYMBOLS (per file) ===');
  for (const [filePath, symbols] of analysis.symbolTable) {
    if (symbols.length === 0) continue;
    lines.push(`\n  ${rel(filePath)}`);
    for (const s of symbols) {
      lines.push(`    [${s.kind}] ${s.name}  (line ${s.line})`);
    }
  }

  // ── 3. Import graph ───────────────────────────────────────────────────────────
  lines.push('\n=== IMPORT GRAPH (file → imports) ===');
  for (const [filePath, imports] of analysis.importGraph) {
    if (imports.length === 0) continue;
    lines.push(`\n  ${rel(filePath)}`);
    for (const imp of imports) {
      lines.push(`    → ${rel(imp)}`);
    }
  }

  // ── 4. Dependency map (who depends on each file) ─────────────────────────────
  lines.push('\n=== DEPENDENCY MAP (file ← depended on by) ===');
  for (const [filePath, dependents] of analysis.dependencyMap) {
    if (dependents.length === 0) continue;
    lines.push(`\n  ${rel(filePath)}`);
    for (const dep of dependents) {
      lines.push(`    ← ${rel(dep)}`);
    }
  }

  // ── 5. Call graph highlights ─────────────────────────────────────────────────
  lines.push('\n=== CALL GRAPH (top-level calls per file) ===');
  for (const [filePath, fa] of analysis.fileMap) {
    const calls = fa.calls.slice(0, maxCallsPerFile);
    if (calls.length === 0) continue;
    lines.push(`\n  ${rel(filePath)}`);
    for (const c of calls) {
      lines.push(`    ${c.caller}() → ${c.callee}()  (line ${c.line})`);
    }
    if (fa.calls.length > maxCallsPerFile) {
      lines.push(`    … and ${fa.calls.length - maxCallsPerFile} more`);
    }
  }

  // ── 6. Parse errors (so agents know which files were skipped) ────────────────
  const errFiles = [...analysis.fileMap.values()].filter(fa => fa.parseError);
  if (errFiles.length > 0) {
    lines.push('\n=== PARSE ERRORS (files skipped by AST analysis) ===');
    for (const fa of errFiles) {
      lines.push(`  ${rel(fa.filePath)}: ${fa.parseError}`);
    }
  }

  return lines.join('\n');
}
