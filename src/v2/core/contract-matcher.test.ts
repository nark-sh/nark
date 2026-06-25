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

  // ──────────────── namespace.method dot/kebab disambiguation ────────────────

  // Concern: trigger.dev namespace.method shared-name disambiguation (deepen-stream
  // pass 92; pattern #15 in bc-deepen-contract Phase 1.5). Contracts that flatten
  // a namespace into a single kebab-cased entry (e.g. `name: batch-retrieve` for
  // `batch.retrieve()`) must route correctly when a sibling namespace (`runs`)
  // exposes a bare-named entry (`name: retrieve`) for the same method.
  it('routes batch.retrieve to the batch-retrieve contract entry, not runs.retrieve', () => {
    const stubContract: PackageContract = {
      package: '_test-kebab',
      semver: '*',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-24',
      functions: [
        // The bare-name `retrieve` is intended for `runs.retrieve()`. Listed first
        // so the bare-name fallback would grab it for any `*.retrieve()` call if the
        // kebab disambiguation were missing.
        {
          name: 'retrieve',
          import_path: '_test-kebab',
          description: 'runs.retrieve',
          postconditions: [
            {
              id: 'runs-retrieve-no-try-catch',
              condition: 'await runs.retrieve()',
              throws: 'ApiError',
              sources: ['https://example.test/runs'],
              severity: 'error',
            },
          ],
        },
        {
          name: 'batch-retrieve',
          import_path: '_test-kebab',
          description: 'batch.retrieve',
          postconditions: [
            {
              id: 'batch-retrieve-no-try-catch',
              condition: 'await batch.retrieve()',
              throws: 'NotFoundError',
              sources: ['https://example.test/batch'],
              severity: 'error',
            },
          ],
        },
      ],
    };
    const stubContracts = new Map<string, PackageContract>([
      ['_test-kebab', stubContract],
    ]);
    const matcher = new ContractMatcher(stubContracts, { projectRoot: PROJECT_ROOT });

    // batch.retrieve() — must route to batch-retrieve, not the bare `retrieve`.
    const batchSource = `await client.batch.retrieve('batch_123');`;
    const batchSf = parse(batchSource);
    const batchCall = findFirst(batchSf, ts.isCallExpression)!;
    const batchDetection: Detection = {
      pluginName: 'test',
      pattern: 'property-chain',
      node: batchCall,
      packageName: '_test-kebab',
      functionName: 'retrieve',
      confidence: 'high',
      metadata: { chainStr: 'batch.retrieve' },
    };
    const batchViolations = matcher.matchDetections([batchDetection], batchSf);
    expect(batchViolations.length).toBeGreaterThan(0);
    expect(batchViolations[0].postconditionId).toBe('batch-retrieve-no-try-catch');

    // runs.retrieve() — must still route to the bare `retrieve` entry via fallback.
    const runsSource = `await client.runs.retrieve('run_123');`;
    const runsSf = parse(runsSource);
    const runsCall = findFirst(runsSf, ts.isCallExpression)!;
    const runsDetection: Detection = {
      pluginName: 'test',
      pattern: 'property-chain',
      node: runsCall,
      packageName: '_test-kebab',
      functionName: 'retrieve',
      confidence: 'high',
      metadata: { chainStr: 'runs.retrieve' },
    };
    const runsViolations = matcher.matchDetections([runsDetection], runsSf);
    expect(runsViolations.length).toBeGreaterThan(0);
    expect(runsViolations[0].postconditionId).toBe('runs-retrieve-no-try-catch');
  });

  // CamelCase chain like `idempotencyKeys.create` must kebab-normalize to
  // `idempotency-keys-create` (camelCase split collapses via the existing
  // snake_case normalization, then `.` and `_` both fold to `-`).
  it('routes camelCase namespace.method (idempotencyKeys.create) to its kebab contract entry', () => {
    const stubContract: PackageContract = {
      package: '_test-camel-kebab',
      semver: '*',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-24',
      functions: [
        {
          name: 'idempotency-keys-create',
          import_path: '_test-camel-kebab',
          description: 'idempotencyKeys.create',
          postconditions: [
            {
              id: 'idempotency-keys-create-not-awaited',
              condition: 'await idempotencyKeys.create()',
              throws: 'IdempotencyError',
              sources: ['https://example.test/'],
              severity: 'error',
            },
          ],
        },
      ],
    };
    const stubContracts = new Map<string, PackageContract>([
      ['_test-camel-kebab', stubContract],
    ]);
    const matcher = new ContractMatcher(stubContracts, { projectRoot: PROJECT_ROOT });
    const source = `await client.idempotencyKeys.create({ key: 'k1' });`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;
    const detection: Detection = {
      pluginName: 'test',
      pattern: 'property-chain',
      node: call,
      packageName: '_test-camel-kebab',
      functionName: 'create',
      confidence: 'high',
      metadata: { chainStr: 'idempotencyKeys.create' },
    };
    const violations = matcher.matchDetections([detection], sf);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].postconditionId).toBe('idempotency-keys-create-not-awaited');
  });

  // The kebab normalization must NOT apply to single-segment chains, or any
  // bare-named entry containing a dash would spuriously match.
  it('does not kebab-match single-segment chains', () => {
    const stubContract: PackageContract = {
      package: '_test-kebab-single',
      semver: '*',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-24',
      functions: [
        {
          name: 'create-token',
          import_path: '_test-kebab-single',
          description: 'createToken',
          postconditions: [
            {
              id: 'create-token-no-try-catch',
              condition: 'await createToken()',
              throws: 'AuthError',
              sources: ['https://example.test/'],
              severity: 'error',
            },
          ],
        },
      ],
    };
    const stubContracts = new Map<string, PackageContract>([
      ['_test-kebab-single', stubContract],
    ]);
    const matcher = new ContractMatcher(stubContracts, { projectRoot: PROJECT_ROOT });
    // A single-segment chainStr "create" must NOT match "create-token" via kebab.
    const source = `await sdk.create();`;
    const sf = parse(source);
    const call = findFirst(sf, ts.isCallExpression)!;
    const detection: Detection = {
      pluginName: 'test',
      pattern: 'property-chain',
      node: call,
      packageName: '_test-kebab-single',
      functionName: 'create',
      confidence: 'high',
      metadata: { chainStr: 'create' },
    };
    const violations = matcher.matchDetections([detection], sf);
    expect(violations).toHaveLength(0);
  });

  // ──────────────── Promise(executor) callback-err-guard suppression ────────────────

  // Evidence: 2026-06-23 audit-stream wave 1+2 candidate #4
  // (callback-err-guard-in-promise-wrapper-not-detected). Canonical promisify shape
  // for callback-style packages — the inner callback registration is FP because the
  // rejection propagates to the outer await; user's try/catch lives there.
  function makeCbContract(): Map<string, PackageContract> {
    const stub: PackageContract = {
      package: '_test-cb',
      semver: '*',
      contract_version: '1.0.0',
      maintainer: 'test',
      last_verified: '2026-06-24',
      functions: [
        {
          name: 'connect',
          import_path: '_test-cb',
          description: 'callback-style connect',
          postconditions: [
            {
              id: 'cb-connect-no-try-catch',
              condition: 'connection.connect(callback)',
              throws: 'ConnectError',
              sources: ['https://example.test/cb'],
              severity: 'error',
            },
          ],
        },
      ],
    };
    return new Map<string, PackageContract>([['_test-cb', stub]]);
  }

  function findCallByCallee(
    sf: ts.SourceFile,
    calleeText: string,
  ): ts.CallExpression {
    const calls: ts.CallExpression[] = [];
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n)) calls.push(n);
      ts.forEachChild(n, visit);
    }
    visit(sf);
    const match = calls.find((c) => {
      if (ts.isPropertyAccessExpression(c.expression)) {
        return c.expression.name.text === calleeText;
      }
      if (ts.isIdentifier(c.expression)) {
        return c.expression.text === calleeText;
      }
      return false;
    });
    if (!match) throw new Error(`could not find call to ${calleeText}`);
    return match;
  }

  it('suppresses positional cb in new Promise(executor) when cb propagates err via reject', () => {
    const source = `
      async function run() {
        await new Promise((resolve, reject) => {
          connection.connect((err, conn) => {
            if (err) { reject(err); return; }
            resolve(conn);
          });
        });
      }
    `;
    const sf = parse(source);
    const call = findCallByCallee(sf, 'connect');
    const matcher = new ContractMatcher(makeCbContract(), { projectRoot: PROJECT_ROOT });
    const violations = matcher.matchDetections(
      [makeDetection(call, '_test-cb', 'connect')],
      sf,
    );
    expect(violations).toHaveLength(0);
  });

  it('suppresses single-line if (err) reject(err)', () => {
    const source = `
      async function run() {
        await new Promise((resolve, reject) => {
          connection.connect((err, conn) => {
            if (err) reject(err);
            else resolve(conn);
          });
        });
      }
    `;
    const sf = parse(source);
    const call = findCallByCallee(sf, 'connect');
    const matcher = new ContractMatcher(makeCbContract(), { projectRoot: PROJECT_ROOT });
    const violations = matcher.matchDetections(
      [makeDetection(call, '_test-cb', 'connect')],
      sf,
    );
    expect(violations).toHaveLength(0);
  });

  it('suppresses named-property cb variant (complete: ...)', () => {
    // snowflake-sdk shape — callback lives on `complete:` property of options object.
    const source = `
      async function run() {
        await new Promise((resolve, reject) => {
          connection.connect({
            sqlText: 'SELECT 1',
            complete: (err, stmt, rows) => {
              if (err) { reject(err); return; }
              resolve(rows);
            },
          });
        });
      }
    `;
    const sf = parse(source);
    const call = findCallByCallee(sf, 'connect');
    const matcher = new ContractMatcher(makeCbContract(), { projectRoot: PROJECT_ROOT });
    const violations = matcher.matchDetections(
      [makeDetection(call, '_test-cb', 'connect')],
      sf,
    );
    expect(violations).toHaveLength(0);
  });

  it('suppresses ternary expression-body cb (err ? reject(err) : resolve(val))', () => {
    const source = `
      async function run() {
        await new Promise((resolve, reject) =>
          connection.connect((err, conn) => err ? reject(err) : resolve(conn))
        );
      }
    `;
    const sf = parse(source);
    const call = findCallByCallee(sf, 'connect');
    const matcher = new ContractMatcher(makeCbContract(), { projectRoot: PROJECT_ROOT });
    const violations = matcher.matchDetections(
      [makeDetection(call, '_test-cb', 'connect')],
      sf,
    );
    expect(violations).toHaveLength(0);
  });

  it('does NOT suppress when cb swallows err (no reject(err) on err path)', () => {
    // Negative case: err is logged but never propagated. Outer await would resolve
    // successfully even on failure — this IS a real bug, must fire.
    const source = `
      async function run() {
        await new Promise((resolve, reject) => {
          connection.connect((err, conn) => {
            console.log(err);
            resolve(conn);
          });
        });
      }
    `;
    const sf = parse(source);
    const call = findCallByCallee(sf, 'connect');
    const matcher = new ContractMatcher(makeCbContract(), { projectRoot: PROJECT_ROOT });
    const violations = matcher.matchDetections(
      [makeDetection(call, '_test-cb', 'connect')],
      sf,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].postconditionId).toBe('cb-connect-no-try-catch');
  });

  it('does NOT suppress when call is outside any new Promise executor', () => {
    // Bare callback registration without a Promise wrapper — err is genuinely
    // unhandled. Must fire.
    const source = `
      function run() {
        connection.connect((err, conn) => {
          if (err) { reject(err); return; }
          handle(conn);
        });
      }
    `;
    const sf = parse(source);
    const call = findCallByCallee(sf, 'connect');
    const matcher = new ContractMatcher(makeCbContract(), { projectRoot: PROJECT_ROOT });
    const violations = matcher.matchDetections(
      [makeDetection(call, '_test-cb', 'connect')],
      sf,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].postconditionId).toBe('cb-connect-no-try-catch');
  });

  it('does NOT suppress when callback first param is not err-shaped', () => {
    // Promise executor exists, but callback's first param is `response` — this is
    // not a node-style err-first callback, so the suppression must not apply.
    const source = `
      async function run() {
        await new Promise((resolve, reject) => {
          connection.connect((response) => {
            resolve(response);
          });
        });
      }
    `;
    const sf = parse(source);
    const call = findCallByCallee(sf, 'connect');
    const matcher = new ContractMatcher(makeCbContract(), { projectRoot: PROJECT_ROOT });
    const violations = matcher.matchDetections(
      [makeDetection(call, '_test-cb', 'connect')],
      sf,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].postconditionId).toBe('cb-connect-no-try-catch');
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
