/**
 * Scanner-precision regression tests — Work Package 0007 (Ladder Step 1).
 *
 * Each recognizer here SUPPRESSES or DOWNGRADES a false positive that a
 * correctly-handled (or inapplicable) call site would otherwise trigger. Every
 * recognizer ships with BOTH:
 *   - a should-NOT-fire case (the FP the recognizer clears), AND
 *   - a should-fire case (the real bug that MUST stay flagged),
 * so a future change that over-suppresses is caught immediately.
 *
 * Recognizers covered:
 *   R1  Promise.allSettled([...]) absorbs rejections (package-agnostic).
 *   R2b @tanstack/react-query mutation-optimistic-update-rollback only applies
 *       when useMutation has an onMutate (optimistic update) option.
 *   R2d @tanstack/react-query combine-loses-error-info only applies when
 *       useQueries has a combine option.
 * (R2a kebab-case hook-file naming and R2c the infinite-query-refetch-all-pages
 *  gated list are covered by the live-benchmark delta in the WP 0007 report and
 *  by the file-name / postcondition-list edits; the two guards below are the
 *  parts with standalone in-function logic worth pinning with a unit test.)
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

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('test.ts', source, ts.ScriptTarget.ES2020, true);
}

function findAll<T extends ts.Node>(
  root: ts.Node,
  predicate: (n: ts.Node) => n is T,
): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (predicate(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** The call named `name` (bare identifier or `.name(...)`). */
function findCall(sf: ts.SourceFile, name: string): ts.CallExpression {
  const calls = findAll(sf, ts.isCallExpression);
  const match = calls.find((c) => {
    const e = c.expression;
    if (ts.isIdentifier(e)) return e.text === name;
    if (ts.isPropertyAccessExpression(e)) return e.name.text === name;
    return false;
  });
  if (!match) throw new Error(`no call to ${name} found`);
  return match;
}

function makeDetection(
  node: ts.CallExpression,
  packageName: string,
  functionName: string,
): Detection {
  return {
    pluginName: 'test',
    pattern: 'throwing-function',
    node,
    packageName,
    functionName,
    confidence: 'high',
    metadata: {},
  };
}

describe('WP 0007 scanner-precision recognizers', () => {
  let contracts: Map<string, PackageContract>;
  const makeMatcher = () =>
    new ContractMatcher(contracts, { projectRoot: PROJECT_ROOT });

  beforeAll(async () => {
    const result = await loadCorpus(CORPUS_PATH);
    contracts = result.contracts;
    expect(contracts.get('axios')).toBeDefined();
    expect(contracts.get('@tanstack/react-query')).toBeDefined();
  });

  // ───────────────────────── R1: Promise.allSettled ─────────────────────────

  describe('R1 Promise.allSettled absorbs rejections (package-agnostic)', () => {
    it('SHOULD NOT fire — axios.get() is a direct element of Promise.allSettled([...])', () => {
      const sf = parse(`Promise.allSettled([axios.get('/a'), axios.get('/b')]);`);
      const call = findCall(sf, 'get');
      const v = makeMatcher().matchDetections(
        [makeDetection(call, 'axios', 'get')],
        sf,
      );
      expect(v.length).toBe(0);
    });

    it('SHOULD NOT fire — axios.get() returned from a .map() callback feeding allSettled', () => {
      const sf = parse(
        `Promise.allSettled(urls.map((u) => axios.get(u)));`,
      );
      const call = findCall(sf, 'get');
      const v = makeMatcher().matchDetections(
        [makeDetection(call, 'axios', 'get')],
        sf,
      );
      expect(v.length).toBe(0);
    });

    it('SHOULD fire — bare axios.get() outside any allSettled (real unhandled call)', () => {
      const sf = parse(`await axios.get('/a');`);
      const call = findCall(sf, 'get');
      const v = makeMatcher().matchDetections(
        [makeDetection(call, 'axios', 'get')],
        sf,
      );
      expect(v.length).toBe(1);
    });

    it('SHOULD fire — axios.get() inside an unrelated nested async fn, not a map callback', () => {
      // The call is created in a separate async function whose result is NOT the
      // element passed to allSettled (allSettled awaits `other`, not this call).
      const sf = parse(`
        async function helper() { return axios.get('/a'); }
        Promise.allSettled([other()]);
      `);
      const call = findCall(sf, 'get');
      const v = makeMatcher().matchDetections(
        [makeDetection(call, 'axios', 'get')],
        sf,
      );
      expect(v.length).toBe(1);
    });
  });

  // NOTE (WP 0007): the sibling R2b guard for mutation-optimistic-update-rollback
  // (suppress useMutation with no onMutate) is deferred — it is correct and clears
  // 5 live-benchmark FPs, but the react-query ground-truth fixture currently
  // asserts SHOULD_FIRE on that exact FP shape. Correcting that fixture is a corpus
  // (contract) stream change; the scanner guard + fixture update must land together.
  // The reactQueryHookOption('useMutation','onMutate') logic is still unit-tested
  // below so the deferred guard is ready to re-enable.

  // ───────────────────── R2d: combine-loses-error-info ─────────────────────
  // combine-loses-error-info is the only error-severity postcondition on
  // useQueries → always the primary. R2d suppresses the detection when there is
  // no combine option (inapplicable), and preserves it when combine is present.

  describe('R2d combine-loses-error-info requires a combine option', () => {
    it('SHOULD NOT fire — useQueries with no combine option is fully suppressed', () => {
      const sf = parse(
        `const r = useQueries({ queries: items.map((i) => ({ queryKey: [i], queryFn: fn })) });`,
      );
      const call = findCall(sf, 'useQueries');
      const v = makeMatcher().matchDetections(
        [makeDetection(call, '@tanstack/react-query', 'useQueries')],
        sf,
      );
      expect(v.length).toBe(0);
    });

    it('SHOULD stay flagged — useQueries WITH combine is not suppressed by R2d', () => {
      const sf = parse(`
        const r = useQueries({
          queries: items.map((i) => ({ queryKey: [i], queryFn: fn })),
          combine: (results) => results.map((x) => x.data),
        });
      `);
      const call = findCall(sf, 'useQueries');
      const v = makeMatcher().matchDetections(
        [makeDetection(call, '@tanstack/react-query', 'useQueries')],
        sf,
      );
      expect(v.length).toBeGreaterThan(0);
    });
  });

  // ─────────────── helper-level unit tests (deterministic core) ───────────────

  describe('reactQueryHookOption helper', () => {
    const optOf = (src: string, callName: string, hook: string, opt: string) => {
      const sf = parse(src);
      const call = findCall(sf, callName);
      return (makeMatcher() as any).reactQueryHookOption(call, hook, opt);
    };

    it('absent when option missing', () => {
      expect(
        optOf(`useMutation({ mutationFn: fn });`, 'useMutation', 'useMutation', 'onMutate'),
      ).toBe('absent');
    });
    it('present when option declared', () => {
      expect(
        optOf(`useMutation({ mutationFn: fn, onMutate: () => {} });`, 'useMutation', 'useMutation', 'onMutate'),
      ).toBe('present');
    });
    it('unknown when options are spread (cannot prove absence)', () => {
      expect(
        optOf(`useMutation({ ...opts });`, 'useMutation', 'useMutation', 'onMutate'),
      ).toBe('unknown');
    });
    it('unknown when the hook call is not found', () => {
      expect(
        optOf(`useMutation({ mutationFn: fn });`, 'useMutation', 'useQueries', 'combine'),
      ).toBe('unknown');
    });
  });

  describe('isAbsorbedByPromiseAllSettled helper', () => {
    const absorbed = (src: string, callName: string) => {
      const sf = parse(src);
      const call = findCall(sf, callName);
      return (makeMatcher() as any).isAbsorbedByPromiseAllSettled(call);
    };
    it('true for direct array element', () => {
      expect(absorbed(`Promise.allSettled([foo()]);`, 'foo')).toBe(true);
    });
    it('true for .map() callback return', () => {
      expect(absorbed(`Promise.allSettled(xs.map((x) => foo(x)));`, 'foo')).toBe(true);
    });
    it('false for bare call', () => {
      expect(absorbed(`foo();`, 'foo')).toBe(false);
    });
    it('false for Promise.all (only allSettled absorbs)', () => {
      expect(absorbed(`Promise.all([foo()]);`, 'foo')).toBe(false);
    });
  });
});
