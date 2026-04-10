/**
 * Tests for PropertyChainDetector
 *
 * Tests depth 1/2/3 property chains and instance tracking.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { PropertyChainDetector } from './property-chain-detector.js';
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

function findAll<T extends ts.Node>(
  root: ts.Node,
  predicate: (n: ts.Node) => n is T
): T[] {
  const results: T[] = [];
  function visit(n: ts.Node): void {
    if (predicate(n)) results.push(n);
    ts.forEachChild(n, visit);
  }
  visit(root);
  return results;
}

function makeImportInfo(packageName: string, importedName: string): ImportInfo {
  return {
    packageName,
    importedName,
    kind: 'default',
    declaration: {} as ts.ImportDeclaration,
  };
}

/** Mock context where typeChecker.getSymbolAtLocation returns a symbol based on identifier text. */
function mockContext(importMap: Map<string, ImportInfo>): NodeContext {
  return {
    typeChecker: {
      getSymbolAtLocation: (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
          return { name: (node as ts.Identifier).text } as ts.Symbol;
        }
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

describe('PropertyChainDetector', () => {
  // ──────────────── depth 1 (should NOT be detected — handled by ThrowingFunctionDetector) ────────────────

  it('ignores depth-1 chains (obj.method()) — ThrowingFunctionDetector handles these', () => {
    const sf = parse(`axios.get('/api');`);
    const call = findFirst(sf, ts.isCallExpression)!;

    const detector = new PropertyChainDetector();
    const importMap = new Map([
      ['axios', makeImportInfo('axios', 'axios')],
    ]);
    const ctx = mockContext(importMap);

    const detections = detector.onCallExpression!(call, ctx);
    expect(detections).toHaveLength(0);
  });

  // ──────────────── depth 2 (obj.prop.method()) ────────────────

  it('detects depth-2 chain (prisma.user.create)', () => {
    const sf = parse(`prisma.user.create({ data });`);
    const call = findFirst(sf, ts.isCallExpression)!;

    const detector = new PropertyChainDetector();
    const importMap = new Map([
      ['prisma', makeImportInfo('@prisma/client', 'PrismaClient')],
    ]);
    const ctx = mockContext(importMap);

    const detections = detector.onCallExpression!(call, ctx);

    expect(detections).toHaveLength(1);
    expect(detections[0].packageName).toBe('@prisma/client');
    expect(detections[0].functionName).toBe('create'); // last segment
    expect(detections[0].pattern).toBe('property-chain');
    expect(detections[0].metadata.depth).toBe(2);
    expect(detections[0].metadata.chainStr).toBe('user.create');
  });

  // ──────────────── depth 3 (obj.prop1.prop2.method()) ────────────────

  it('detects depth-3 chain (openai.chat.completions.create)', () => {
    const sf = parse(`openai.chat.completions.create({ messages });`);
    const call = findFirst(sf, ts.isCallExpression)!;

    const detector = new PropertyChainDetector();
    const importMap = new Map([
      ['openai', makeImportInfo('openai', 'OpenAI')],
    ]);
    const ctx = mockContext(importMap);

    const detections = detector.onCallExpression!(call, ctx);

    expect(detections).toHaveLength(1);
    expect(detections[0].packageName).toBe('openai');
    expect(detections[0].functionName).toBe('create'); // last segment
    expect(detections[0].metadata.depth).toBe(3);
    expect(detections[0].metadata.chainStr).toBe('chat.completions.create');
  });

  // ──────────────── no import → no detection ────────────────

  it('returns empty when root identifier is not in importMap or instanceMap', () => {
    const sf = parse(`unknown.prop.method();`);
    const call = findFirst(sf, ts.isCallExpression)!;

    const detector = new PropertyChainDetector();
    const ctx = mockContext(new Map());

    const detections = detector.onCallExpression!(call, ctx);
    expect(detections).toHaveLength(0);
  });

  // ──────────────── instance tracking via VariableDeclaration ────────────────

  it('tracks instances from new expressions and detects property chains on them', () => {
    const sf = parse(`
      const prisma = new PrismaClient();
      prisma.user.findMany();
    `);

    const calls = findAll(sf, ts.isCallExpression);
    const varDecl = findFirst(sf, ts.isVariableDeclaration)!;

    const detector = new PropertyChainDetector();
    const importMap = new Map([
      ['PrismaClient', makeImportInfo('@prisma/client', 'PrismaClient')],
    ]);
    const ctx = mockContext(importMap);

    // First, process the variable declaration to track the instance
    detector.onVariableDeclaration!(varDecl, ctx);

    // Then process the property chain call
    const findManyCall = calls.find(c =>
      ts.isPropertyAccessExpression(c.expression) &&
      (c.expression as ts.PropertyAccessExpression).name.text === 'findMany'
    );
    expect(findManyCall).toBeDefined();

    const detections = detector.onCallExpression!(findManyCall!, ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].packageName).toBe('@prisma/client');
    expect(detections[0].functionName).toBe('findMany');
  });

  // ──────────────── instance tracker plugin integration ────────────────

  it('uses shared instanceTracker to resolve factory-created instances', () => {
    const sf = parse(`client.list.all();`);
    const call = findFirst(sf, ts.isCallExpression)!;

    const mockInstanceTracker = {
      resolveIdentifier: (name: string) => name === 'client' ? 'stripe' : null,
    } as any;

    const detector = new PropertyChainDetector(mockInstanceTracker);
    const ctx = mockContext(new Map()); // empty importMap, relies on instanceTracker

    const detections = detector.onCallExpression!(call, ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].packageName).toBe('stripe');
    expect(detections[0].functionName).toBe('all');
  });

  // ──────────────── resets between files ────────────────

  it('resets instanceMap between source files (beforeTraversal)', () => {
    const sf1 = parse(`const prisma = new PrismaClient();`);
    const varDecl1 = findFirst(sf1, ts.isVariableDeclaration)!;

    const detector = new PropertyChainDetector();
    const importMap = new Map([
      ['PrismaClient', makeImportInfo('@prisma/client', 'PrismaClient')],
    ]);
    detector.onVariableDeclaration!(varDecl1, mockContext(importMap));

    // Simulate new file
    const sf2 = parse(`prisma.user.create();`);
    detector.beforeTraversal!(sf2, mockContext(new Map()));

    const call = findFirst(sf2, ts.isCallExpression)!;
    const detections = detector.onCallExpression!(call, mockContext(new Map()));

    // After reset, prisma instance is no longer tracked
    expect(detections).toHaveLength(0);
  });
});
