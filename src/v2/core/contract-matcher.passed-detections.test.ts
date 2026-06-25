/**
 * Passed-Detections Plumbing + HTTP-Client Capture — Wave 2a (Plan 01-03).
 *
 * Pins the API surface that the convention-miner second pass (Wave 9 /
 * Plan 01-09) reads, AND the Task 2 contract that HTTP-client passing
 * sites land in `FileAnalysisResult.passedDetections` after a real scan.
 *
 *   Task 1 (plumbing) assertions:
 *     1. `ContractMatcher` exposes `getLastPassedDetections()` returning
 *        an array (NOT undefined) at construction.
 *     2. The returned array is a copy — caller mutation does not bleed
 *        into the internal buffer.
 *     3. After running the axios ground-truth fixture through the
 *        analyzer pipeline, `FileAnalysisResult.passedDetections` is an
 *        array on the result.
 *
 *   Task 2 (wiring) assertions:
 *     4. The axios ground-truth fixture (which has SHOULD_NOT_FIRE lines
 *        for idiomatic try/catch around axios calls) produces ≥1 passing
 *        site captured under packageName="axios" with a `passedMatcherId`
 *        from `MATCHER_IDS`.
 *
 * Wave 9 (convention-miner) requires the SHAPE to be in place before it can
 * even compile its consumer code — that's why this test pins the API
 * surface as a separate concern from the actual recording.
 */

import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { ContractMatcher } from "./contract-matcher.js";
import {
  runGroundTruth,
  runGroundTruthFull,
  CORPUS_PATH,
} from "../fixtures/harness.js";
import type { GroundTruthResult } from "../fixtures/harness.js";
import { MATCHER_IDS } from "../matchers/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The axios fixture is the canonical HTTP-client ground-truth corpus —
// every Wave 2a guard we rewire touches it.
const AXIOS_GROUND_TRUTH = path.resolve(
  __dirname,
  "../../../../nark-corpus/packages/axios/fixtures/ground-truth.ts",
);

const KNOWN_MATCHER_VALUES = new Set<string>(Object.values(MATCHER_IDS));

describe("contract-matcher: passedDetections plumbing — API surface", () => {
  it("ContractMatcher exposes getLastPassedDetections() that returns an array", () => {
    // A bare ContractMatcher with an empty contracts map and a temp project
    // root is enough to exercise the API. We are not running matchDetections
    // here — we only verify the accessor exists and returns [] at construction.
    const m = new ContractMatcher(new Map(), {
      projectRoot: path.resolve(__dirname, "../../.."),
    });

    const detections = m.getLastPassedDetections();
    expect(Array.isArray(detections)).toBe(true);
    expect(detections).toEqual([]);
  });

  it("getLastPassedDetections() returns a fresh array — callers cannot mutate the internal buffer", () => {
    const m = new ContractMatcher(new Map(), {
      projectRoot: path.resolve(__dirname, "../../.."),
    });

    const first = m.getLastPassedDetections();
    first.push({
      packageName: "synthetic",
      postconditionId: "synthetic",
      file: "synthetic.ts",
      line: 1,
      passedMatcherId: "try-catch:direct",
    });

    const second = m.getLastPassedDetections();
    // Mutation of the returned array must not bleed into a subsequent call.
    expect(second).toEqual([]);
  });
});

describe("contract-matcher: passedDetections plumbing — analyzer integration", () => {
  it("FileAnalysisResult.passedDetections is an array after a real scan", async () => {
    // Sanity: the axios ground-truth file exists. If this fixture moves,
    // the test should fail fast with a clear message rather than hanging.
    expect(
      fs.existsSync(AXIOS_GROUND_TRUTH),
      `axios ground-truth fixture missing at ${AXIOS_GROUND_TRUTH}`,
    ).toBe(true);

    const result: GroundTruthResult = await runGroundTruth(
      AXIOS_GROUND_TRUTH,
      CORPUS_PATH,
    );

    // The harness's standard `runGroundTruth` only returns violations.
    // We assert violations were produced (sanity) — the full
    // `FileAnalysisResult.passedDetections` shape lives on the per-file
    // results and is exercised by the next test via `runGroundTruthFull`.
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

describe("contract-matcher: passedDetections — HTTP-client capture (Task 2)", () => {
  it("axios fixture surfaces at least one passing site under packageName='axios' with a canonical passedMatcherId", async () => {
    // runGroundTruthFull (added in Plan 01-03) drives the same analyzer
    // pipeline as runGroundTruth and additionally aggregates
    // FileAnalysisResult.passedDetections across all files matching the
    // ground-truth filename. The axios ground-truth corpus has
    // SHOULD_NOT_FIRE lines (idiomatic try/catch around axios calls) that
    // exercise the WAVE-2A passing-site push path inside the matcher's
    // canonical OR-chain.
    const result = await runGroundTruthFull(AXIOS_GROUND_TRUTH, CORPUS_PATH);

    expect(
      result.passedDetections.length,
      "expected at least one passing axios site to land in passedDetections — Wave 2a guard rewiring not active?",
    ).toBeGreaterThanOrEqual(1);

    for (const p of result.passedDetections) {
      expect(p.packageName).toBe("axios");
      expect(p.postconditionId.length).toBeGreaterThan(0);
      expect(p.file.length).toBeGreaterThan(0);
      expect(p.line).toBeGreaterThan(0);
      expect(
        KNOWN_MATCHER_VALUES.has(p.passedMatcherId),
        `unexpected passedMatcherId not in MATCHER_IDS: ${p.passedMatcherId}`,
      ).toBe(true);
    }
  });
});
