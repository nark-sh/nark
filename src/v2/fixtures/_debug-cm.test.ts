import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { runGroundTruth } from "./harness.js";
import type { GroundTruthResult } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRO_CORPUS_PATH = path.resolve(__dirname, "../../../../nark-corpus-pro");
const GROUND_TRUTH_PATH = path.resolve(
  PRO_CORPUS_PATH,
  "packages/cache-manager/fixtures/ground-truth.ts",
);

describe("cache-manager debug", () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, {
      includeDrafts: true,
      packageName: "cache-manager",
    });
  });

  it("dump all violations", () => {
    console.log("Violations:", JSON.stringify(result.violations.map(v => ({
      line: v.line,
      package: v.package,
      function: v.function,
      postcondition: v.postconditionId,
    })), null, 2));
    expect(true).toBe(true);
  });
});
