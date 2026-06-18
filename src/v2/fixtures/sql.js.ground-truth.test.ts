/**
 * sql.js Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/sql.js/fixtures/ground-truth.ts
 * becomes one test case.
 *
 * Postcondition ID from nark-corpus-pro/packages/sql.js/contract.yaml:
 *   wasm-load-failure  (initSqlJs(...) rejects on WASM load failure)
 *
 * Key behaviors under test:
 *   - await initSqlJs(...) without try/catch → SHOULD_FIRE
 *   - await initSqlJs(...) inside try/catch → SHOULD_NOT_FIRE
 *   - initSqlJs(...).catch(...) chain → SHOULD_NOT_FIRE
 *
 * sql.js's full API surface has exactly ONE Promise-returning function
 * (initSqlJs). All Database/Statement methods are synchronous and outside
 * nark's async-error-handling model, so this is the only contracted function.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
} from './harness.js';
import type { GroundTruthResult, Annotation } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// nark-corpus-pro is a sibling of nark-corpus: ../../../../nark-corpus-pro
const CORPUS_PRO_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  CORPUS_PRO_PATH,
  'packages/sql.js/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('sql.js: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: 'sql.js',
    });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
