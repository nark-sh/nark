import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  discoverTsconfig,
  rankTsconfigCandidates,
  collectTsconfigCandidates,
  countProjectTsFiles,
  shouldWarnLowCoverage,
} from "./tsconfig-discovery.js";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nark-disc-"));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function writeTsFiles(dir: string, count: number): void {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(
      path.join(dir, `file${i}.ts`),
      `export const x${i} = ${i};\n`,
    );
  }
}

describe("tsconfig-discovery", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("rankTsconfigCandidates", () => {
    it("Test 1: prefers root tsconfig.base.json over apps/e2e/tsconfig.json (Tracearr-shape)", () => {
      // Tracearr-shape: no root tsconfig.json, only tsconfig.base.json + monorepo signals
      writeFile(
        path.join(tmp, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      writeFile(path.join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
      writeFile(path.join(tmp, "turbo.json"), "{}");
      writeFile(
        path.join(tmp, "apps", "e2e", "tsconfig.json"),
        JSON.stringify({ include: ["**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "apps", "e2e"), 1);
      writeFile(
        path.join(tmp, "apps", "server", "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "apps", "server", "src"), 30);

      const ranked = rankTsconfigCandidates(
        collectTsconfigCandidates(tmp),
        tmp,
      );
      expect(ranked.length).toBeGreaterThan(0);
      expect(path.basename(ranked[0].path)).toBe("tsconfig.base.json");
      expect(ranked[0].depth).toBe(0);
    });

    it("Test 2: prefers a composite tsconfig with `references` over a non-composite leaf one at the same depth", () => {
      // Two siblings at the same depth: composite root vs. plain leaf
      writeFile(
        path.join(tmp, "tsconfig.json"),
        JSON.stringify({
          references: [{ path: "./apps/server" }],
          files: [],
        }),
      );
      writeFile(
        path.join(tmp, "tsconfig.build.json"),
        JSON.stringify({ include: ["src/**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "src"), 5);

      const ranked = rankTsconfigCandidates(
        collectTsconfigCandidates(tmp),
        tmp,
      );
      // Composite root should rank first thanks to compositeBonus
      expect(path.basename(ranked[0].path)).toBe("tsconfig.json");
      expect(ranked[0].isComposite).toBe(true);
    });

    it("Test 3: file-count tie-breaker — broader include wins between two similar configs", () => {
      // Two depth-2 monorepo tsconfigs with same basename/composite-ness
      // — broader include should beat narrow one via fileCountScore.
      writeFile(
        path.join(tmp, "apps", "wide", "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "apps", "wide", "src"), 80);

      writeFile(
        path.join(tmp, "apps", "narrow", "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "apps", "narrow", "src"), 2);

      const ranked = rankTsconfigCandidates(
        collectTsconfigCandidates(tmp),
        tmp,
      );
      // Both depth-2, both tsconfig.json, neither composite — fileCount decides.
      const wideIdx = ranked.findIndex((c) => c.path.includes("wide"));
      const narrowIdx = ranked.findIndex((c) => c.path.includes("narrow"));
      expect(wideIdx).toBeGreaterThanOrEqual(0);
      expect(narrowIdx).toBeGreaterThanOrEqual(0);
      expect(wideIdx).toBeLessThan(narrowIdx);
    });
  });

  describe("shouldWarnLowCoverage", () => {
    it("Test 4: returns warn=true with reason absolute_low when filesAnalyzed=1 and project has 500 files", () => {
      const result = shouldWarnLowCoverage({
        filesAnalyzed: 1,
        totalTsFiles: 500,
      });
      expect(result.warn).toBe(true);
      // 1 < 5 triggers absolute_low first
      expect(result.reason).toBe("absolute_low");
    });

    it("Test 4b: returns warn=true with reason ratio_low when filesAnalyzed=10 of 500 (above absolute floor, below ratio)", () => {
      const result = shouldWarnLowCoverage({
        filesAnalyzed: 10,
        totalTsFiles: 500,
      });
      expect(result.warn).toBe(true);
      expect(result.reason).toBe("ratio_low");
    });

    it("Test 5: returns warn=false when filesAnalyzed=200 of 500 (40% coverage is plenty)", () => {
      const result = shouldWarnLowCoverage({
        filesAnalyzed: 200,
        totalTsFiles: 500,
      });
      expect(result.warn).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("Test 6: returns warn=false when filesAnalyzed=1 and totalTsFiles=1 (genuinely tiny project)", () => {
      const result = shouldWarnLowCoverage({
        filesAnalyzed: 1,
        totalTsFiles: 1,
      });
      expect(result.warn).toBe(false);
      expect(result.reason).toBeNull();
    });
  });

  describe("discoverTsconfig", () => {
    it("Test 7: Tracearr-shape regression — returns the root tsconfig.base.json, NOT apps/e2e/tsconfig.json", () => {
      // Canonical regression test for the bug this plan exists to fix.
      writeFile(
        path.join(tmp, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      writeFile(path.join(tmp, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
      writeFile(path.join(tmp, "turbo.json"), "{}");

      // Narrow leaf — used to win on "first match"
      writeFile(
        path.join(tmp, "apps", "e2e", "tsconfig.json"),
        JSON.stringify({ include: ["**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "apps", "e2e"), 1);

      // Broader sibling configs
      writeFile(
        path.join(tmp, "apps", "server", "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "apps", "server", "src"), 50);

      writeFile(
        path.join(tmp, "apps", "web", "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "apps", "web", "src"), 30);

      writeFile(
        path.join(tmp, "packages", "shared", "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"] }),
      );
      writeTsFiles(path.join(tmp, "packages", "shared", "src"), 20);

      const picked = discoverTsconfig(tmp);
      expect(picked).not.toBeNull();
      expect(path.basename(picked!)).toBe("tsconfig.base.json");
      expect(picked).not.toMatch(/apps[\/\\]e2e/);
    });
  });

  describe("countProjectTsFiles", () => {
    it("counts .ts/.tsx files and skips node_modules/dist/.next/.turbo", () => {
      writeTsFiles(path.join(tmp, "src"), 7);
      writeTsFiles(path.join(tmp, "node_modules", "foo"), 50);
      writeTsFiles(path.join(tmp, "dist"), 20);
      writeTsFiles(path.join(tmp, ".next"), 30);
      // Also add a .d.ts that should NOT be counted
      writeFile(path.join(tmp, "src", "types.d.ts"), "export {};");
      expect(countProjectTsFiles(tmp)).toBe(7);
    });
  });
});
