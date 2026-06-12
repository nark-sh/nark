/**
 * @alicloud/dysmsapi20170525 Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@alicloud/dysmsapi20170525/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/@alicloud/dysmsapi20170525/contract.yaml:
 *   send-sms-with-options-no-try-catch
 *   send-sms-no-try-catch
 *   send-batch-sms-with-options-no-try-catch
 *   send-batch-sms-no-try-catch
 *   send-card-sms-with-options-no-try-catch
 *   send-card-sms-no-try-catch
 *
 * Key behaviors under test:
 *   - await client.sendSmsWithOptions(req, opts)       without try-catch → SHOULD_FIRE
 *   - await client.sendSms(req)                        without try-catch → SHOULD_FIRE
 *   - await client.sendBatchSmsWithOptions(req, opts)  without try-catch → SHOULD_FIRE
 *   - await client.sendBatchSms(req)                   without try-catch → SHOULD_FIRE
 *   - await client.sendCardSmsWithOptions(req, opts)   without try-catch → SHOULD_FIRE
 *   - await client.sendCardSms(req)                    without try-catch → SHOULD_FIRE
 *   - any of the above inside try-catch                                  → SHOULD_NOT_FIRE
 *   - await client.sendSms(req).catch(...)                               → SHOULD_NOT_FIRE
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
  'packages/@alicloud/dysmsapi20170525/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@alicloud/dysmsapi20170525: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: '@alicloud/dysmsapi20170525',
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
