/**
 * @nestjs/cache-manager Ground-Truth Tests
 *
 * Validates that the contract correctly fires on bare `await cache.set/mset/
 * del/mdel/clear/wrap/disconnect()` calls and stays silent inside try-catch.
 * Read methods (get/mget/ttl) must NEVER fire because the upstream
 * implementation swallows store errors and returns undefined.
 *
 * Contract in nark-corpus-pro. Postcondition IDs:
 *   set-unhandled-promise-rejection
 *   mset-unhandled-promise-rejection
 *   del-unhandled-promise-rejection
 *   mdel-unhandled-promise-rejection
 *   clear-unhandled-promise-rejection
 *   wrap-unhandled-promise-rejection
 *   disconnect-unhandled-promise-rejection (warning)
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
} from "./harness.js";
import type { GroundTruthResult, Annotation } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRO_CORPUS_PATH = path.resolve(__dirname, "../../../../nark-corpus-pro");
const GROUND_TRUTH_PATH = path.resolve(
  PRO_CORPUS_PATH,
  "packages/@nestjs/cache-manager/fixtures/ground-truth.ts",
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe("@nestjs/cache-manager: ground-truth fixture", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, {
      includeDrafts: true,
      packageName: "@nestjs/cache-manager",
    });
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

  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_FIRE")) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter((a) => a.kind === "SHOULD_NOT_FIRE")) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
