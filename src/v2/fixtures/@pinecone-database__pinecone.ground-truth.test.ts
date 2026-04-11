/**
 * @pinecone-database/pinecone Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@pinecone-database/pinecone/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@pinecone-database/pinecone/contract.yaml:
 *   upsert-no-error-handling
 *   query-no-error-handling
 *   fetch-no-error-handling
 *   deleteOne-no-error-handling
 *   deleteMany-no-error-handling
 *   listIndexes-no-error-handling
 *
 * Key behaviors under test:
 *   - index.upsert() without try-catch → SHOULD_FIRE
 *   - index.query() without try-catch → SHOULD_FIRE
 *   - index.fetch() without try-catch → SHOULD_FIRE
 *   - index.deleteOne() / deleteMany() without try-catch → SHOULD_FIRE
 *   - pinecone.listIndexes() without try-catch → SHOULD_FIRE
 *   - All above WITH try-catch → SHOULD_NOT_FIRE
 *
 * Pinecone pattern: new Pinecone({apiKey}) → pinecone.index('name') → index.upsert()
 * The index is a factory method result from the Pinecone class instance.
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
  '../../../../nark-corpus/packages/@pinecone-database/pinecone/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@pinecone-database/pinecone: ground-truth fixture', () => {
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
