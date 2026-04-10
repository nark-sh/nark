/**
 * @slack/web-api Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@slack/web-api/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@slack/web-api/contract.yaml:
 *   chat-update-no-trycatch              (chat.update() without try-catch)
 *   chat-postephemeral-no-trycatch       (chat.postEphemeral() without try-catch)
 *   chat-delete-no-trycatch              (chat.delete() without try-catch)
 *   chat-schedulemessage-no-trycatch     (chat.scheduleMessage() without try-catch)
 *   conversations-create-no-trycatch     (conversations.create() without try-catch)
 *   conversations-history-no-trycatch    (conversations.history() without try-catch)
 *   conversations-open-no-trycatch       (conversations.open() without try-catch)
 *   views-open-no-trycatch              (views.open() without try-catch)
 *   reactions-add-no-trycatch           (reactions.add() without try-catch)
 *   filesuploadv2-no-trycatch           (filesUploadV2() without try-catch)
 *   users-lookupbyemail-no-trycatch     (users.lookupByEmail() without try-catch)
 *
 * Key behaviors under test:
 *   - await client.chat.update() without try-catch → SHOULD_FIRE
 *   - await client.chat.update() inside try-catch → SHOULD_NOT_FIRE
 *   - await client.chat.postEphemeral() without try-catch → SHOULD_FIRE
 *   - await client.conversations.create() without try-catch → SHOULD_FIRE
 *   - await client.conversations.open() without try-catch → SHOULD_FIRE
 *   - await client.views.open() without try-catch → SHOULD_FIRE
 *   - await client.reactions.add() without try-catch → SHOULD_FIRE
 *   - await client.filesUploadV2() without try-catch → SHOULD_FIRE
 *   - await client.users.lookupByEmail() without try-catch → SHOULD_FIRE
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
  '../../../../corpus/packages/@slack/web-api/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@slack/web-api: ground-truth fixture', () => {
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
