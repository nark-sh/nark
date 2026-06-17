/**
 * Tests for .nark/config.json read/write + repo-root discovery.
 * Spec: .planning/research/nark-cli-discovery-ux.md (Part B).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

import {
  readNarkConfig,
  writeNarkConfig,
  findRepoRoot,
} from "./nark-config.js";

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `nark-narkconfig-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

describe("nark-config", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const root = tmpRoots.pop()!;
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function setup(): string {
    const root = makeTmpDir();
    tmpRoots.push(root);
    return root;
  }

  describe("readNarkConfig", () => {
    it("returns null when the file does not exist", () => {
      const root = setup();
      expect(readNarkConfig(root)).toBeNull();
    });

    it("returns the parsed object when the file is valid", () => {
      const root = setup();
      writeFile(
        path.join(root, ".nark", "config.json"),
        JSON.stringify({ workspace: "acme", tsconfig: "packages/core/tsconfig.json" }),
      );
      const result = readNarkConfig(root);
      expect(result).toEqual({
        workspace: "acme",
        tsconfig: "packages/core/tsconfig.json",
      });
    });

    it("returns null on malformed JSON (does not throw)", () => {
      const root = setup();
      writeFile(path.join(root, ".nark", "config.json"), "{ not json");
      expect(readNarkConfig(root)).toBeNull();
    });
  });

  describe("writeNarkConfig", () => {
    it("creates .nark/ and writes the patch when no file exists", () => {
      const root = setup();
      writeNarkConfig(root, {
        tsconfig: "packages/core/tsconfig.json",
        savedAt: "2026-06-17T00:00:00Z",
        savedFrom: "interactive-picker",
      });
      const back = readNarkConfig(root);
      expect(back).toEqual({
        tsconfig: "packages/core/tsconfig.json",
        savedAt: "2026-06-17T00:00:00Z",
        savedFrom: "interactive-picker",
      });
    });

    it("merges patch on top of existing config (preserves untouched fields)", () => {
      const root = setup();
      // Simulate `nark workspace use --here acme` writing first.
      writeFile(
        path.join(root, ".nark", "config.json"),
        JSON.stringify({ workspace: "acme" }),
      );

      // Now the picker writes tsconfig.
      writeNarkConfig(root, {
        tsconfig: "tsconfig.json",
        savedAt: "2026-06-17T00:00:00Z",
        savedFrom: "interactive-picker",
      });

      const back = readNarkConfig(root);
      expect(back?.workspace).toBe("acme");
      expect(back?.tsconfig).toBe("tsconfig.json");
      expect(back?.savedAt).toBe("2026-06-17T00:00:00Z");
    });
  });

  describe("findRepoRoot", () => {
    it("returns the dir containing .git", () => {
      const root = setup();
      fs.mkdirSync(path.join(root, ".git"));
      const deep = path.join(root, "packages", "core", "src");
      fs.mkdirSync(deep, { recursive: true });

      expect(fs.realpathSync(findRepoRoot(deep))).toBe(fs.realpathSync(root));
    });

    it("returns the dir containing pnpm-workspace.yaml", () => {
      const root = setup();
      writeFile(
        path.join(root, "pnpm-workspace.yaml"),
        'packages:\n  - "packages/*"\n',
      );
      const deep = path.join(root, "packages", "core");
      fs.mkdirSync(deep, { recursive: true });
      expect(fs.realpathSync(findRepoRoot(deep))).toBe(fs.realpathSync(root));
    });

    it("returns the dir containing lerna.json", () => {
      const root = setup();
      writeFile(
        path.join(root, "lerna.json"),
        JSON.stringify({ packages: ["packages/*"] }),
      );
      const deep = path.join(root, "packages", "core");
      fs.mkdirSync(deep, { recursive: true });
      expect(fs.realpathSync(findRepoRoot(deep))).toBe(fs.realpathSync(root));
    });

    it("returns the dir containing package.json with `workspaces` field", () => {
      const root = setup();
      writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "monorepo", workspaces: ["packages/*"] }),
      );
      const deep = path.join(root, "packages", "core");
      fs.mkdirSync(deep, { recursive: true });
      expect(fs.realpathSync(findRepoRoot(deep))).toBe(fs.realpathSync(root));
    });

    it("returns the start dir when no marker is found", () => {
      const root = setup();
      // No markers anywhere — the function falls back to the start dir.
      expect(fs.realpathSync(findRepoRoot(root))).toBe(fs.realpathSync(root));
    });
  });
});
