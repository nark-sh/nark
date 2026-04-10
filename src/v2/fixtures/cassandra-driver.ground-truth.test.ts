/**
 * cassandra-driver Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/cassandra-driver/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/cassandra-driver/contract.yaml:
 *   connection-failure           (client.connect() without try-catch)
 *   syntax-error                 (client.execute() without try-catch)
 *   batch-failure                (client.batch() without try-catch)
 *   stream-error                 (client.stream() without .on('error') listener)
 *   mapper-insert-no-try-catch   (ModelMapper.insert() without try-catch)
 *   mapper-update-no-try-catch   (ModelMapper.update() without try-catch)
 *   mapper-remove-no-try-catch   (ModelMapper.remove() without try-catch)
 *   mapper-get-null-not-checked  (ModelMapper.get() result used without null check)
 *   mapper-get-no-try-catch      (ModelMapper.get() without try-catch)
 *   mapper-find-no-try-catch     (ModelMapper.find() without try-catch)
 *   execute-concurrent-no-try-catch          (executeConcurrent() without try-catch)
 *   execute-concurrent-errors-not-checked    (executeConcurrent(raiseOnFirstError=false) without checking errors[])
 *
 * Key behaviors under test:
 *   - await client.connect() without try-catch → SHOULD_FIRE
 *   - await client.execute() without try-catch → SHOULD_FIRE
 *   - await client.batch() without try-catch → SHOULD_FIRE
 *   - client.stream() without .on('error') → SHOULD_FIRE
 *   - await userMapper.insert() without try-catch → SHOULD_FIRE
 *   - await userMapper.update() without try-catch → SHOULD_FIRE
 *   - await userMapper.remove() without try-catch → SHOULD_FIRE
 *   - await userMapper.get() result used without null check → SHOULD_FIRE
 *   - await userMapper.get() without try-catch → SHOULD_FIRE
 *   - await userMapper.find() without try-catch → SHOULD_FIRE
 *   - await executeConcurrent() without try-catch → SHOULD_FIRE
 *   - await executeConcurrent({raiseOnFirstError:false}) without errors check → SHOULD_FIRE
 *   - All above inside try-catch (or with proper checks) → SHOULD_NOT_FIRE
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
  '../../../../corpus/packages/cassandra-driver/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('cassandra-driver: ground-truth fixture', () => {
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
