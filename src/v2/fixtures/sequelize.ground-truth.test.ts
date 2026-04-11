/**
 * sequelize Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/sequelize/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/sequelize/contract.yaml:
 *   connection-failure    (sequelize.authenticate())
 *   close-failure         (sequelize.close())
 *   query-failure         (Model.findAll(), findAndCountAll(), aggregate, max, min, sum)
 *   unique-constraint     (Model.create(), instance.save())
 *   unique-constraint-race (Model.findOrCreate())
 *   validation-error      (Model.upsert())
 *   restore-failure       (Model.restore())
 *   increment-failure     (Model.increment())
 *   decrement-failure     (Model.decrement())
 *   truncate-failure      (Model.truncate())
 *   reload-deleted        (instance.reload())
 *   validation-failure    (instance.validate())
 *
 * Key behaviors under test:
 *   - await sequelize.authenticate()              without try-catch → SHOULD_FIRE
 *   - await sequelize.close()                     without try-catch → SHOULD_FIRE
 *   - await Model.findAll/findAndCountAll/etc()   without try-catch → SHOULD_FIRE
 *   - await Model.create/bulkCreate/upsert()      without try-catch → SHOULD_FIRE
 *   - await Model.findOrCreate()                  without try-catch → SHOULD_FIRE
 *   - await instance.save/reload/validate()       without try-catch → SHOULD_FIRE
 *   - Any of the above inside try-catch → SHOULD_NOT_FIRE
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
  '../../../../nark-corpus/packages/sequelize/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('sequelize: ground-truth fixture', () => {
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
