/**
 * @notionhq/client Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@notionhq/client/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@notionhq/client/contract.yaml:
 *   api-error (used by all 5 contracted functions: query, create, update, append, search)
 *
 * Key behaviors under test:
 *   - notion.databases.query()        without try-catch → SHOULD_FIRE: api-error
 *   - notion.pages.create()           without try-catch → SHOULD_FIRE: api-error
 *   - notion.pages.update()           without try-catch → SHOULD_FIRE: api-error
 *   - notion.blocks.children.append() without try-catch → SHOULD_FIRE: api-error
 *   - notion.search()                 without try-catch → SHOULD_FIRE: api-error
 *   - Any of the above inside try-catch               → SHOULD_NOT_FIRE
 *   - .catch() chain                                  → SHOULD_NOT_FIRE
 *   - try-finally without catch                       → SHOULD_FIRE
 *   - Class field instance methods without try-catch  → SHOULD_FIRE
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
  '../../../../corpus/packages/@notionhq/client/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@notionhq/client: ground-truth fixture', () => {
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
