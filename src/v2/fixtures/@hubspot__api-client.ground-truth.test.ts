/**
 * @hubspot/api-client Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@hubspot/api-client/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@hubspot/api-client/contract.yaml:
 *   create-no-try-catch   — create() without try/catch (contacts, meetings, associations)
 *   update-no-try-catch   — update() without try/catch (contacts, meetings)
 *   archive-no-try-catch  — archive() without try/catch (meetings)
 *   doSearch-no-try-catch — doSearch() without try/catch (contacts)
 *   getById-no-try-catch  — getById() without try/catch (contacts)
 *
 * Key behaviors under test:
 *   - client.crm.contacts.basicApi.create()         without try-catch → SHOULD_FIRE
 *   - client.crm.objects.meetings.basicApi.create() without try-catch → SHOULD_FIRE
 *   - client.crm.contacts.basicApi.update()         without try-catch → SHOULD_FIRE
 *   - client.crm.objects.meetings.basicApi.update() without try-catch → SHOULD_FIRE
 *   - client.crm.objects.meetings.basicApi.archive() without try-catch → SHOULD_FIRE
 *   - client.crm.contacts.searchApi.doSearch()      without try-catch → SHOULD_FIRE
 *   - client.crm.contacts.basicApi.getById()        without try-catch → SHOULD_FIRE
 *   - Any of the above inside try-catch                               → SHOULD_NOT_FIRE
 *
 * Detection relies on:
 *   - InstanceTracker resolving `new hubspot.Client()` → '@hubspot/api-client'
 *   - PropertyChainDetector matching deep chains (4-5 levels)
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
  '../../../../corpus/packages/@hubspot/api-client/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@hubspot/api-client: ground-truth fixture', () => {
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
