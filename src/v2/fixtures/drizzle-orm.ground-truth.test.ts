/**
 * drizzle-orm Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/drizzle-orm/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/drizzle-orm/contract.yaml:
 *   select-query-error            (db.select())
 *   insert-constraint-violation   (db.insert())
 *   update-constraint-violation   (db.update())
 *   transaction-rollback-error    (db.transaction())
 *   execute-query-error           (db.execute())
 *
 * Key behaviors under test:
 *   - await db.select().from(table)           without try-catch → SHOULD_FIRE
 *   - await db.insert(table).values({...})    without try-catch → SHOULD_FIRE
 *   - await db.update(table).set({}).where()  without try-catch → SHOULD_FIRE
 *   - await db.transaction(async (tx) => {})  without try-catch → SHOULD_FIRE
 *   - await db.execute(sql`...`)              without try-catch → SHOULD_FIRE
 *   - Any of the above inside try-catch → SHOULD_NOT_FIRE
 *
 * Detection path: drizzle() factory → db instance tracked →
 *   ThrowingFunctionDetector fires builder chains →
 *   ContractMatcher checks try-catch → postconditions fire
 *
 * Design: spec-driven, NOT based on V1 behavior.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
  CORPUS_PATH,
} from './harness.js';
import type { GroundTruthResult, Annotation } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus/packages/drizzle-orm/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('drizzle-orm: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  // One test per SHOULD_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
