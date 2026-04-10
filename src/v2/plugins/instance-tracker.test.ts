/**
 * Tests for InstanceTrackerPlugin
 *
 * Tests classToPackage vs importMap priority, factory detection,
 * and resolveIdentifier.
 */

import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { InstanceTrackerPlugin } from './instance-tracker.js';
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


/** Build a mock NodeContext with an importMap. */
function mockContext(importMap: Map<string, ImportInfo>): NodeContext {
  return {
    typeChecker: {} as ts.TypeChecker,
    symbolTable: new Map(),
    importMap,
    controlFlow: {} as any,
    sourceFile: {} as ts.SourceFile,
    program: {} as ts.Program,
    node: {} as ts.Node,
    depth: 0,
  };
}

function makeImportInfo(packageName: string, importedName: string): ImportInfo {
  return {
    packageName,
    importedName,
    kind: 'named',
    declaration: {} as ts.ImportDeclaration,
  };
}

// ────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────

describe('InstanceTrackerPlugin', () => {
  const factoryToPackage = new Map<string, string>([
    ['createClient', 'redis'],
    ['connect', 'mongoose'],
  ]);

  const classToPackage = new Map<string, string>([
    ['PrismaClient', '@prisma/client'],
    ['Stripe', 'stripe'],
    ['Client', 'pg'], // ambiguous name
  ]);

  // ──────────────── importMap priority over classToPackage ────────────────

  it('importMap takes priority over classToPackage for class names', () => {
    // 'Client' is in classToPackage → 'pg', but import says it's from 'discord.js'
    const sf = parse(`const client = new Client();`);
    const varDecl = findFirst(sf, ts.isVariableDeclaration)!;

    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    plugin.beforeTraversal(sf, mockContext(new Map()));

    // importMap says 'Client' comes from discord.js (overrides classToPackage)
    const importMap = new Map([
      ['Client', makeImportInfo('discord.js', 'Client')],
    ]);
    const ctx = mockContext(importMap);

    plugin.onVariableDeclaration(varDecl, ctx);

    // Should resolve to discord.js (importMap), not pg (classToPackage)
    expect(plugin.resolveIdentifier('client')).toBe('discord.js');
  });

  it('falls back to classToPackage when no importMap entry for class', () => {
    const sf = parse(`const prisma = new PrismaClient();`);
    const varDecl = findFirst(sf, ts.isVariableDeclaration)!;

    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    plugin.beforeTraversal(sf, mockContext(new Map()));

    const ctx = mockContext(new Map()); // no importMap entry for PrismaClient
    plugin.onVariableDeclaration(varDecl, ctx);

    // Falls back to classToPackage
    expect(plugin.resolveIdentifier('prisma')).toBe('@prisma/client');
  });

  // ──────────────── factory method detection ────────────────

  it('tracks factory method from factoryToPackage map', () => {
    const sf = parse(`const client = createClient(url, key);`);
    const varDecl = findFirst(sf, ts.isVariableDeclaration)!;

    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    plugin.beforeTraversal(sf, mockContext(new Map()));

    const ctx = mockContext(new Map());
    plugin.onVariableDeclaration(varDecl, ctx);

    expect(plugin.resolveIdentifier('client')).toBe('redis');
  });

  it('tracks async factory method (await createClient(...))', () => {
    const sf = parse(`const client = await createClient(url, key);`);
    const varDecl = findFirst(sf, ts.isVariableDeclaration)!;

    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    plugin.beforeTraversal(sf, mockContext(new Map()));

    const ctx = mockContext(new Map());
    plugin.onVariableDeclaration(varDecl, ctx);

    expect(plugin.resolveIdentifier('client')).toBe('redis');
  });

  // ──────────────── resolveIdentifier ────────────────

  it('returns null for untracked identifiers', () => {
    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    expect(plugin.resolveIdentifier('someRandomVar')).toBeNull();
  });

  it('resets instanceMap between files (beforeTraversal)', () => {
    const sf1 = parse(`const stripe = new Stripe(key);`);
    const varDecl1 = findFirst(sf1, ts.isVariableDeclaration)!;

    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    plugin.beforeTraversal(sf1, mockContext(new Map()));
    plugin.onVariableDeclaration(varDecl1, mockContext(new Map()));

    expect(plugin.resolveIdentifier('stripe')).toBe('stripe');

    // Simulate new file traversal — should reset
    const sf2 = parse(`const x = 1;`);
    plugin.beforeTraversal(sf2, mockContext(new Map()));

    expect(plugin.resolveIdentifier('stripe')).toBeNull();
  });

  // ──────────────── new expression via importMap ────────────────

  it('resolves new expression when import is in importMap', () => {
    const sf = parse(`const stripe = new Stripe(apiKey);`);
    const varDecl = findFirst(sf, ts.isVariableDeclaration)!;

    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    plugin.beforeTraversal(sf, mockContext(new Map()));

    // Stripe import is from 'stripe' package
    const importMap = new Map([
      ['Stripe', makeImportInfo('stripe', 'Stripe')],
    ]);
    plugin.onVariableDeclaration(varDecl, mockContext(importMap));

    expect(plugin.resolveIdentifier('stripe')).toBe('stripe');
  });

  // ──────────────── no tracking for non-factory identifiers ────────────────

  it('does not track plain function calls that are not factory methods', () => {
    const sf = parse(`const result = processData(input);`);
    const varDecl = findFirst(sf, ts.isVariableDeclaration)!;

    const plugin = new InstanceTrackerPlugin(factoryToPackage, classToPackage);
    plugin.beforeTraversal(sf, mockContext(new Map()));
    plugin.onVariableDeclaration(varDecl, mockContext(new Map()));

    expect(plugin.resolveIdentifier('result')).toBeNull();
  });
});
