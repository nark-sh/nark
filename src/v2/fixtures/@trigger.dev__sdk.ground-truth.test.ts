/**
 * @trigger.dev/sdk Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@trigger.dev/sdk/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@trigger.dev/sdk/contract.yaml:
 *   trigger-no-try-catch          — tasks.trigger() without try/catch
 *   batchtrigger-no-try-catch     — tasks.batchTrigger() without try/catch
 *   retrieve-no-try-catch         — runs.retrieve() without try/catch
 *   list-no-try-catch             — runs.list() without try/catch
 *   schedules-create-no-try-catch — schedules.create() without try/catch
 *   schedules-update-no-try-catch — schedules.update() without try/catch
 *
 * Key behaviors under test:
 *   - tasks.trigger("id", payload)          without try-catch → SHOULD_FIRE
 *   - tasks.batchTrigger([...])             without try-catch → SHOULD_FIRE
 *   - runs.retrieve(runId)                  without try-catch → SHOULD_FIRE
 *   - runs.list({ tag, limit })             without try-catch → SHOULD_FIRE
 *   - schedules.create({ task, cron, ... }) without try-catch → SHOULD_FIRE
 *   - schedules.update(scheduleId, options) without try-catch → SHOULD_FIRE
 *   - Any of the above inside try-catch                      → SHOULD_NOT_FIRE
 *
 * Detection relies on:
 *   - ImportTracker resolving `import { tasks, schedules, runs } from '@trigger.dev/sdk'`
 *   - PropertyChainDetector matching 2-level chains (tasks.trigger, runs.list, etc.)
 *   - Subpath normalization: @trigger.dev/sdk/v3 → @trigger.dev/sdk
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
  '../../../../corpus/packages/@trigger.dev/sdk/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@trigger.dev/sdk: ground-truth fixture', () => {
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
