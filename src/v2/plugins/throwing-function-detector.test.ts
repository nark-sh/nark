/**
 * Tests for ThrowingFunctionDetector
 *
 * Tests property access calls (obj.method()) and direct calls (fn()).
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { ThrowingFunctionDetector } from './throwing-function-detector.js';
import type { NodeContext, ImportInfo } from '../types/index.js';

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('test.ts', source, ts.ScriptTarget.ES2020, true);
}

function findFirst<T extends ts.Node>(
  root: ts.Node,
  predicate: (n: ts.Node) => n is T
): T | undefined {
  let found: T | undefined;
  function visit(n: ts.Node): void {
    if (found) return;
    if (predicate(n)) { found = n; return; }
    ts.forEachChild(n, visit);
  }
  visit(root);
  return found;
}

function makeImportInfo(packageName: string, importedName: string): ImportInfo {
  return {
    packageName,
    importedName,
    kind: 'default',
    declaration: {} as ts.ImportDeclaration,
  };
}

/** Create a mock NodeContext that returns symbol.name from type checker. */
function mockContext(importMap: Map<string, ImportInfo>, symbolName?: string): NodeContext {
  return {
    typeChecker: {
      getSymbolAtLocation: (_node: ts.Node) => {
        if (symbolName) return { name: symbolName } as ts.Symbol;
        // Try to extract name from identifier node
        if (ts.isIdentifier(_node)) return { name: (_node as ts.Identifier).text } as ts.Symbol;
        return undefined;
      },
    } as unknown as ts.TypeChecker,
    symbolTable: new Map(),
    importMap,
    controlFlow: {} as any,
    sourceFile: {} as ts.SourceFile,
    program: {} as ts.Program,
    node: {} as ts.Node,
    depth: 0,
  };
}

// ────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────

describe('ThrowingFunctionDetector', () => {
  // ──────────────── property access: obj.method() ────────────────

  describe('property access calls (depth 1)', () => {
    it('detects axios.get() and returns correct detection', () => {
      const sf = parse(`axios.get('/api');`);
      const call = findFirst(sf, ts.isCallExpression)!;

      const detector = new ThrowingFunctionDetector();
      const importMap = new Map([
        ['axios', makeImportInfo('axios', 'axios')],
      ]);
      const ctx = mockContext(importMap);

      const detections = detector.onCallExpression!(call, ctx);

      expect(detections).toHaveLength(1);
      expect(detections[0].packageName).toBe('axios');
      expect(detections[0].functionName).toBe('get');
      expect(detections[0].pattern).toBe('throwing-function');
    });

    it('returns empty for depth-2 chain (obj.prop.method) — deferred to PropertyChainDetector', () => {
      const sf = parse(`stripe.charges.create({});`);
      const call = findFirst(sf, ts.isCallExpression)!;

      const detector = new ThrowingFunctionDetector();
      const importMap = new Map([
        ['stripe', makeImportInfo('stripe', 'stripe')],
      ]);
      const ctx = mockContext(importMap, 'stripe');

      const detections = detector.onCallExpression!(call, ctx);

      // depth > 1 chains are delegated to PropertyChainDetector
      expect(detections).toHaveLength(0);
    });

    it('returns empty when root identifier is not in importMap', () => {
      const sf = parse(`unknownLib.get('/api');`);
      const call = findFirst(sf, ts.isCallExpression)!;

      const detector = new ThrowingFunctionDetector();
      const ctx = mockContext(new Map()); // empty importMap

      const detections = detector.onCallExpression!(call, ctx);
      expect(detections).toHaveLength(0);
    });
  });

  // ──────────────── direct call: fn() ────────────────

  describe('direct function calls', () => {
    it('detects named import used as direct call', () => {
      // import { get } from 'axios'; get('/api');
      const sf = parse(`get('/api');`);
      const call = findFirst(sf, ts.isCallExpression)!;

      const detector = new ThrowingFunctionDetector();
      const importMap = new Map([
        ['get', {
          packageName: 'axios',
          importedName: 'get',
          kind: 'named' as const,
          declaration: {} as ts.ImportDeclaration,
        }],
      ]);
      const ctx = mockContext(importMap);

      const detections = detector.onCallExpression!(call, ctx);

      expect(detections).toHaveLength(1);
      expect(detections[0].packageName).toBe('axios');
      expect(detections[0].functionName).toBe('get');
    });

    it('returns empty for direct call not in importMap', () => {
      const sf = parse(`processData(input);`);
      const call = findFirst(sf, ts.isCallExpression)!;

      const detector = new ThrowingFunctionDetector();
      const ctx = mockContext(new Map());

      const detections = detector.onCallExpression!(call, ctx);
      expect(detections).toHaveLength(0);
    });
  });

  // ──────────────── instance tracker integration ────────────────

  describe('instance tracker integration', () => {
    it('detects calls on factory-created instances via instance tracker', () => {
      const sf = parse(`client.get('/api');`);
      const call = findFirst(sf, ts.isCallExpression)!;

      const mockInstanceTracker = {
        resolveIdentifier: (name: string) => name === 'client' ? 'axios' : null,
      } as any;

      const detector = new ThrowingFunctionDetector(mockInstanceTracker);
      const ctx = mockContext(new Map(), 'client'); // no importMap, but instance tracker knows

      const detections = detector.onCallExpression!(call, ctx);

      expect(detections).toHaveLength(1);
      expect(detections[0].packageName).toBe('axios');
      expect(detections[0].functionName).toBe('get');
    });

    it('returns empty when instance tracker does not know the identifier', () => {
      const sf = parse(`unknownClient.get('/api');`);
      const call = findFirst(sf, ts.isCallExpression)!;

      const mockInstanceTracker = {
        resolveIdentifier: (_name: string) => null,
      } as any;

      const detector = new ThrowingFunctionDetector(mockInstanceTracker);
      const ctx = mockContext(new Map(), 'unknownClient');

      const detections = detector.onCallExpression!(call, ctx);
      expect(detections).toHaveLength(0);
    });
  });
});
