import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeRepo } from '../engine/repo-scanner.js';

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const abs = (rel) => path.join(root, rel);

let repo;
const sym = (rel) => repo.fileMap.get(abs(rel)).symbols;
const callsOf = (rel) => repo.fileMap.get(abs(rel)).calls;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-lang-')));

  write('pkg/__init__.py', '');
  write('pkg/helpers.py', 'def double(x):\n    return x * 2\n');
  write('pkg/util.py', [
    '"""def fake(): pass"""',
    'from . import helpers',
    '__all__ = ["add"]',
    'LIMIT = 3',
    'def add(a, b):',
    '    # ghost()',
    '    s = "not_a_call(x)"',
    '    return helpers.double(a) + b',
    'class Greeter:',
    '    def hello(self):',
    '        return add(1, LIMIT)',
    '',
  ].join('\n'));
  write('__pycache__/skip.py', 'def nope(): pass\n');

  write('go.mod', 'module example.com/demo\n\ngo 1.21\n');
  write('main.go', [
    'package main',
    'import (',
    '\t"fmt"',
    '\t"example.com/demo/internal/calc"',
    ')',
    'const Version = "1"',
    'type Server struct{ Name string }',
    'func (s *Server) Start() { fmt.Println(calc.Add(1, 2)) }',
    'func helper() {}',
    'func main() { helper() }',
    '',
  ].join('\n'));
  write('internal/calc/calc.go', 'package calc\n// func Fake() {}\nfunc Add(a, b int) int { return a + b }\n');
  write('vendor/x/x.go', 'package x\nfunc V() {}\n');

  write('src/main/java/com/acme/util/Strings.java',
    'package com.acme.util;\npublic final class Strings {\n  public static String up(String s) { return s.toUpperCase(); }\n}\n');
  write('src/main/java/com/acme/App.java', [
    'package com.acme;',
    'import com.acme.util.Strings;',
    '/** class Fake { } */',
    'public class App {',
    '  private int count = compute(3);',
    '  public App() { }',
    '  public static void main(String[] args) { new App(); Strings.up("x"); }',
    '  private int compute(int n) { return n + 1; }',
    '  interface Shape { double area(); }',
    '}',
    '',
  ].join('\n'));

  repo = await analyzeRepo(root);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('python analysis', () => {
  it('resolves relative imports into the import graph', () => {
    expect(repo.importGraph.get(abs('pkg/util.py'))).toContain(abs('pkg/helpers.py'));
  });

  it('honours __all__ and ignores strings, docstrings and comments', () => {
    const s = sym('pkg/util.py');
    expect(s.find(x => x.name === 'add').exported).toBe(true);
    expect(s.find(x => x.name === 'Greeter').exported).toBe(false);
    expect(s.find(x => x.name === 'fake')).toBeUndefined();
    const callees = callsOf('pkg/util.py').map(c => c.callee);
    expect(callees).not.toContain('ghost');
    expect(callees).not.toContain('not_a_call');
  });

  it('attributes calls to the enclosing def', () => {
    const c = callsOf('pkg/util.py');
    expect(c).toContainEqual(expect.objectContaining({ caller: 'add', callee: 'helpers.double' }));
    expect(c).toContainEqual(expect.objectContaining({ caller: 'hello', callee: 'add' }));
  });

  it('skips pruned directories', () => {
    expect(repo.fileMap.has(abs('__pycache__/skip.py'))).toBe(false);
  });
});

describe('go analysis', () => {
  it('resolves module-local imports to the package files', () => {
    expect(repo.importGraph.get(abs('main.go'))).toEqual([abs('internal/calc/calc.go')]);
  });

  it('reports exported symbols with Go visibility rules', () => {
    const s = sym('main.go');
    expect(s.find(x => x.name === 'Server.Start')).toMatchObject({ kind: 'function', exported: true });
    expect(s.find(x => x.name === 'helper').exported).toBe(false);
    expect(s.find(x => x.name === 'Version')).toMatchObject({ kind: 'variable', exported: true });
    expect(s.find(x => x.name === 'Server').kind).toBe('type');
    expect(sym('internal/calc/calc.go').find(x => x.name === 'Fake')).toBeUndefined();
  });

  it('builds the call graph and ignores declaration names', () => {
    const c = callsOf('main.go');
    expect(c).toContainEqual(expect.objectContaining({ caller: 'Start', callee: 'calc.Add' }));
    expect(c).toContainEqual(expect.objectContaining({ caller: 'main', callee: 'helper' }));
    expect(c.find(x => x.callee === 'Start')).toBeUndefined();
  });

  it('prunes vendor/', () => {
    expect(repo.fileMap.has(abs('vendor/x/x.go'))).toBe(false);
  });
});

describe('java analysis', () => {
  it('resolves imports to files in the repo', () => {
    expect(repo.importGraph.get(abs('src/main/java/com/acme/App.java')))
      .toEqual([abs('src/main/java/com/acme/util/Strings.java')]);
  });

  it('lists types and methods with visibility', () => {
    const s = sym('src/main/java/com/acme/App.java');
    expect(s.find(x => x.name === 'App')).toMatchObject({ kind: 'class', exported: true });
    expect(s.find(x => x.name === 'App.main').exported).toBe(true);
    expect(s.find(x => x.name === 'App.compute').exported).toBe(false);
    expect(s.find(x => x.name === 'App.Shape.area').exported).toBe(true); // interface members are public
    expect(s.find(x => x.name === 'Fake')).toBeUndefined();
  });

  it('records constructor calls and attributes calls to methods', () => {
    const c = callsOf('src/main/java/com/acme/App.java');
    expect(c).toContainEqual(expect.objectContaining({ caller: 'main', callee: 'new App' }));
    expect(c).toContainEqual(expect.objectContaining({ caller: 'main', callee: 'Strings.up' }));
    expect(c.find(x => x.callee === 'compute')).toMatchObject({ caller: '<module>' }); // field initializer
    expect(c.find(x => x.callee === 'main')).toBeUndefined();
  });
});
