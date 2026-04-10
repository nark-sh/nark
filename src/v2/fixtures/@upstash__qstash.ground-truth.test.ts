/**
 * @upstash/qstash Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@upstash/qstash/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@upstash/qstash/contract.yaml:
 *   api-error: publishJSON/publish/enqueueJSON called without try/catch
 *
 * Key behaviors under test:
 *   - client.publishJSON() without try-catch   → SHOULD_FIRE: api-error
 *   - client.publishJSON() inside try-catch    → SHOULD_NOT_FIRE
 *   - client.publish() without try-catch       → SHOULD_FIRE: api-error
 *   - client.publish() inside try-catch        → SHOULD_NOT_FIRE
 *   - queue.enqueueJSON() without try-catch    → SHOULD_FIRE: api-error
 *   - queue.enqueueJSON() inside try-catch     → SHOULD_NOT_FIRE
 *
 * @upstash/qstash uses the Client and Receiver class patterns tracked via
 * class_names: ["Client", "Receiver"] in the contract.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
  CORPUS_PATH,
} from "./harness.js";
import type { GroundTruthResult, Annotation } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  "../../../../corpus/packages/@upstash/qstash/fixtures/ground-truth.ts",
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe("@upstash/qstash: ground-truth fixture", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
  });

  it("analyzer runs without errors", () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations", () => {
    expect(
      ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE").length,
    ).toBeGreaterThan(0);
    expect(
      ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE").length,
    ).toBeGreaterThan(0);
  });

  // One test per SHOULD_FIRE annotation
  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE")) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE")) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
