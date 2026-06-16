/**
 * @aws-sdk/client-bedrock-runtime Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@aws-sdk/client-bedrock-runtime/fixtures/ground-truth.ts
 * becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/@aws-sdk/client-bedrock-runtime/contract.yaml:
 *   bedrock-invoke-model-no-try-catch              (InvokeModelCommand — no try-catch)
 *   bedrock-converse-no-try-catch                  (ConverseCommand — no try-catch)
 *   bedrock-converse-stream-no-try-catch           (ConverseStreamCommand — no try-catch)
 *   bedrock-converse-stream-errors-not-checked     (stream chunk error events unchecked)
 *   bedrock-invoke-model-stream-no-try-catch       (InvokeModelWithResponseStream — no try-catch)
 *   bedrock-apply-guardrail-no-try-catch           (ApplyGuardrailCommand — no try-catch)
 *   bedrock-start-async-invoke-no-try-catch        (StartAsyncInvokeCommand — no try-catch)
 *   bedrock-get-async-invoke-no-try-catch          (GetAsyncInvokeCommand — no try-catch)
 *
 * Key behaviors under test:
 *   - bedrockClient.send(new XxxCommand(...)) without try-catch → SHOULD_FIRE
 *   - same call inside try-catch                                 → SHOULD_NOT_FIRE
 *   - All commands: InvokeModel, Converse, ConverseStream,
 *     InvokeModelWithResponseStream, ApplyGuardrail, StartAsyncInvoke,
 *     GetAsyncInvoke — all routed through send()
 *
 * AWS SDK v3 command pattern: client.send(new XxxCommand(params)).
 * Detected as instance.send() property chain — same pattern as sibling AWS SDK clients
 * (client-lambda, client-s3, client-cloudwatch-logs).
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
  'packages/@aws-sdk/client-bedrock-runtime/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@aws-sdk/client-bedrock-runtime: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: '@aws-sdk/client-bedrock-runtime',
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
