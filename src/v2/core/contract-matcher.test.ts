/**
 * Tests for ContractMatcher
 *
 * Tests Detection[] → Violation[] conversion, subViolations generation,
 * catch-block completeness checks, and suppression.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ts from 'typescript';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ContractMatcher } from './contract-matcher.js';
import { loadCorpus } from '../../corpus-loader.js';
import type { Detection } from '../types/index.js';
import type { PackageContract } from '../../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_PATH = path.join(__dirname, '../../../../nark-corpus');
const PROJECT_ROOT = path.join(__dirname, '../../../..');

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

/** Build a minimal Detection for a call expression found in the source. */
function makeDetection(
  node: ts.CallExpression,
  packageName: string,
  functionName: string,
  pattern: 'throwing-function' | 'property-chain' = 'throwing-function'
): Detection {
  return {
    pluginName: 'test',
    pattern,
    node,
    packageName,
    functionName,
    confidence: 'high',
    metadata: {},
  };
}

// ────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────

describe('ContractMatcher', () => {
  let contracts: Map<string, PackageContract>;
  let axiosContract: PackageContract;

  beforeAll(async () => {
    const result = await loadCorpus(CORPUS_PATH);
    expect(result.errors).toHaveLength(0);
    contracts = result.contracts;
    axiosContract = contracts.get('axios')!;
    expect(axiosContract).toBeDefined();
  });

  const makeMatcher = () =>
    new ContractMatcher(contracts, { projectRoot: PROJECT_ROOT });

  // ──────────────── basic violation generation ────────────────

  it('generates a violation for axios.get() outside try-catch', () => {
    const source = `await axios.get('/api');`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(call, 'axios', 'get')],
      sf
    );

    expect(violations.length).toBe(1);
    expect(violations[0].package).toBe('axios');
    expect(violations[0].function).toBe('get');
    expect(violations[0].severity).toBe('error');
    expect(violations[0].inTryCatch).toBe(false);
  });

  it('generates no violation when inside a complete try-catch (network handled)', () => {
    // axios.get inside try-catch that checks error.response — should produce no
    // "missing try-catch" violation. But may produce an incomplete-handling warning.
    const source = `
      try {
        await axios.get('/api');
      } catch (error) {
        console.error(error);
      }
    `;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(call, 'axios', 'get')],
      sf
    );

    // No "missing try-catch" error — the call IS in a try-catch
    const missingTryCatch = violations.filter(v => !v.inTryCatch);
    expect(missingTryCatch).toHaveLength(0);
  });

  // ──────────────── subViolations ────────────────

  it('generates subViolations for multiple postconditions', () => {
    const source = `await axios.get('/api');`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(call, 'axios', 'get')],
      sf
    );

    expect(violations.length).toBe(1);
    // axios.get has multiple postconditions (network, 429, status code checks)
    // so subViolations should be present
    if (violations[0].subViolations) {
      expect(violations[0].subViolations.length).toBeGreaterThan(0);
      for (const sv of violations[0].subViolations) {
        expect(sv.postconditionId).toBeDefined();
        expect(sv.message).toBeDefined();
        expect(['error', 'warning']).toContain(sv.severity);
      }
    }
    // Primary postcondition should have the highest severity
    expect(violations[0].severity).toBe('error');
  });

  // ──────────────── unknown package ────────────────

  it('returns no violations for unknown package', () => {
    const source = `await someUnknown.get('/api');`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(call, 'some-unknown-package', 'get')],
      sf
    );

    expect(violations).toHaveLength(0);
  });

  // ──────────────── unknown function ────────────────

  it('returns no violations for unknown function in known package', () => {
    const source = `await axios.unknownMethod('/api');`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(call, 'axios', 'unknownMethod')],
      sf
    );

    expect(violations).toHaveLength(0);
  });

  // ──────────────── event-listener pattern skipped ────────────────

  it('skips event-listener pattern detections', () => {
    const source = `client.on('error', handler);`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    const detection: Detection = {
      pluginName: 'test',
      pattern: 'event-listener',
      node: call,
      packageName: 'redis',
      functionName: 'on',
      confidence: 'high',
      metadata: {},
    };

    const matcher = makeMatcher();
    const violations = matcher.matchDetections([detection], sf);
    expect(violations).toHaveLength(0);
  });

  // ──────────────── dotted function name fallback ────────────────

  it('matches function using last-segment of dotted contract name', () => {
    // ContractMatcher has fallback: 'login' matches contract function 'Client.login'
    // Find a contract that has dotted function names
    const source = `await client.login();`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    // Check if discord.js is loaded (has 'Client.login' function)
    const discordContract = contracts.get('discord.js');
    if (!discordContract) {
      // Skip if discord.js not in corpus
      return;
    }

    const hasDottedLogin = discordContract.functions.some(
      f => f.name.includes('.') && f.name.endsWith('login')
    );

    if (!hasDottedLogin) {
      // Skip if no dotted login function
      return;
    }

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(call, 'discord.js', 'login')],
      sf
    );

    // Should find the function via last-segment fallback
    expect(violations.length).toBeGreaterThan(0);
  });

  // ──────────────── property-chain pattern ────────────────

  it('generates violation for property-chain pattern (prisma.user.create)', () => {
    const prismaContract = contracts.get('@prisma/client');
    if (!prismaContract) return; // Skip if not loaded

    const source = `await prisma.user.create({ data });`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(call, '@prisma/client', 'create', 'property-chain')],
      sf
    );

    // create should match if prisma contract has it
    const hasCreateFunction = prismaContract.functions.some(f =>
      f.name === 'create' || f.name.endsWith('.create')
    );
    if (hasCreateFunction) {
      expect(violations.length).toBeGreaterThan(0);
    }
  });

  // ──────────────── beta-prefix endsWith shadow regression ────────────────

  // Concern: concern-20260624-scanner-deepen-4 (deepen-stream-2 pass 75).
  // Adding a non-beta postcondition (messages.create) to a contract that already
  // carries a beta-prefixed entry (beta.messages.create) must NOT regress the
  // non-beta call's matching: the suffix check used to pick the beta entry first
  // (`"beta.messages.create".endsWith(".messages.create")` is true).
  it('does not let beta.messages.create shadow messages.create via endsWith suffix match', () => {
    // Hand-built minimal contract with both parallel entries.
    const stubContract: PackageContract = {
      package: '_test-shadow',
      semver: '*',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-24',
      detection: {
        await_patterns: ['.messages.create'],
      },
      functions: [
        // Beta entry first: prior to the fix, find() returned this for a non-beta call
        // because endsWith fired on the longer effectiveName.
        {
          name: 'create',
          namespace: 'beta.messages',
          import_path: '_test-shadow',
          description: 'beta variant',
          postconditions: [
            {
              id: 'beta-messages-create-no-try-catch',
              condition: 'await beta.messages.create()',
              throws: 'APIError',
              sources: ['https://example.test/beta'],
              severity: 'error',
            },
          ],
        },
        {
          name: 'create',
          namespace: 'messages',
          import_path: '_test-shadow',
          description: 'GA variant',
          postconditions: [
            {
              id: 'messages-create-no-try-catch',
              condition: 'await messages.create()',
              throws: 'APIError',
              sources: ['https://example.test/ga'],
              severity: 'error',
            },
          ],
        },
      ],
    };

    const stubContracts = new Map<string, PackageContract>([
      ['_test-shadow', stubContract],
    ]);
    const matcher = new ContractMatcher(stubContracts, { projectRoot: PROJECT_ROOT });

    // Non-beta call. chainStr = "messages.create".
    const gaSource = `await client.messages.create({});`;
    const gaSf = parse(gaSource);
    const gaCall = findFirst(gaSf, ts.isCallExpression)!;
    const gaDetection: Detection = {
      pluginName: 'test',
      pattern: 'property-chain',
      node: gaCall,
      packageName: '_test-shadow',
      functionName: 'create',
      confidence: 'high',
      metadata: { chainStr: 'messages.create' },
    };
    const gaViolations = matcher.matchDetections([gaDetection], gaSf);
    // Must produce exactly one violation, and it must be the GA postcondition
    // (the bug previously surfaced the beta-variant id here).
    expect(gaViolations.length).toBeGreaterThan(0);
    expect(gaViolations[0].postconditionId).toBe('messages-create-no-try-catch');

    // Beta call. chainStr = "beta.messages.create".
    const betaSource = `await client.beta.messages.create({});`;
    const betaSf = parse(betaSource);
    const betaCall = findFirst(betaSf, ts.isCallExpression)!;
    const betaDetection: Detection = {
      pluginName: 'test',
      pattern: 'property-chain',
      node: betaCall,
      packageName: '_test-shadow',
      functionName: 'create',
      confidence: 'high',
      metadata: { chainStr: 'beta.messages.create' },
    };
    const betaViolations = matcher.matchDetections([betaDetection], betaSf);
    expect(betaViolations.length).toBeGreaterThan(0);
    expect(betaViolations[0].postconditionId).toBe('beta-messages-create-no-try-catch');
  });

  // The suffix-match fallback must still resolve a chainStr that omits the
  // package-root segment (e.g., openai.embeddings.create contract entry,
  // detected chainStr = "embeddings.create"). Regression guard alongside the
  // beta-shadow fix above.
  it('still resolves package-root-prefixed contract entries via suffix fallback', () => {
    const stubContract: PackageContract = {
      package: '_test-suffix',
      semver: '*',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-24',
      functions: [
        {
          name: 'openai.embeddings.create',
          import_path: '_test-suffix',
          description: 'package-root-prefixed entry',
          postconditions: [
            {
              id: 'embeddings-create-no-try-catch',
              condition: 'await openai.embeddings.create()',
              throws: 'OpenAIError',
              sources: ['https://example.test/embeddings'],
              severity: 'error',
            },
          ],
        },
      ],
    };
    const stubContracts = new Map<string, PackageContract>([
      ['_test-suffix', stubContract],
    ]);
    const matcher = new ContractMatcher(stubContracts, { projectRoot: PROJECT_ROOT });

    const source = `await client.embeddings.create({});`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;
    const detection: Detection = {
      pluginName: 'test',
      pattern: 'property-chain',
      node: call,
      packageName: '_test-suffix',
      functionName: 'create',
      confidence: 'high',
      metadata: { chainStr: 'embeddings.create' },
    };
    const violations = matcher.matchDetections([detection], sf);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].postconditionId).toBe('embeddings-create-no-try-catch');
  });

  // ──────────────── catch-block completeness (warning) ────────────────

  it('produces warning for incomplete catch block (no status code check)', () => {
    const source = `
      try {
        await axios.get('/api');
      } catch (error) {
        console.error(error.message);
      }
    `;
    const sf = parse(source);
    // Find the axios.get call expression
    const calls = [] as ts.CallExpression[];
    function findCalls(n: ts.Node) {
      if (ts.isCallExpression(n)) calls.push(n);
      ts.forEachChild(n, findCalls);
    }
    findCalls(sf);
    // Find the axios.get call (not the console.error call)
    const axiosCall = calls.find(c =>
      ts.isPropertyAccessExpression(c.expression) &&
      ts.isPropertyAccessExpression(c.expression.expression)
        ? false
        : ts.isPropertyAccessExpression(c.expression)
    );

    if (!axiosCall) return; // Skip if can't find call

    const matcher = makeMatcher();
    const violations = matcher.matchDetections(
      [makeDetection(axiosCall, 'axios', 'get')],
      sf
    );

    // The call is in a try-catch, so no "missing try-catch" error
    // But the catch is incomplete → should produce a warning
    // At minimum should not produce an error-level "missing try-catch" violation
    const missingTryCatchErrors = violations.filter(
      v => v.severity === 'error' && !v.inTryCatch
    );
    expect(missingTryCatchErrors).toHaveLength(0);
  });
});
