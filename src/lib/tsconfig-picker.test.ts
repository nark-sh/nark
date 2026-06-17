/**
 * Tests for the interactive tsconfig picker.
 * Spec: .planning/research/nark-cli-discovery-ux.md (Part B).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Readable, Writable } from "stream";

import {
  selectPickerCandidates,
  promptPicker,
} from "./tsconfig-picker.js";

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `nark-tspicker-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

function makeMockStdin(input: string): Readable {
  return Readable.from([input]);
}

function makeMockStdout(): { stream: Writable; captured: string } {
  let captured = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });
  return {
    stream,
    get captured() {
      return captured;
    },
  } as any;
}

describe("tsconfig-picker", () => {
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

  describe("selectPickerCandidates", () => {
    it("returns null when there is only one tsconfig in the project", () => {
      const root = setup();
      writeFile(path.join(root, "tsconfig.json"), "{}");
      writeFile(path.join(root, "src", "index.ts"), "");

      expect(selectPickerCandidates(root)).toBeNull();
    });

    it("returns null when the top candidate dominates by more than CLOSE_SCORE_GAP", () => {
      // Root tsconfig (depth 0 +1000 +100 basename) vs a depth-2 package
      // tsconfig (depth 2 +200 +100 basename) — the gap is huge, no picker.
      const root = setup();
      writeFile(path.join(root, "tsconfig.json"), "{}");
      writeFile(path.join(root, "src", "index.ts"), "");

      fs.mkdirSync(path.join(root, "packages", "pkg-a"), { recursive: true });
      writeFile(path.join(root, "packages", "pkg-a", "tsconfig.json"), "{}");

      const result = selectPickerCandidates(root);
      expect(result).toBeNull();
    });

    it("returns candidates when scores are close (two depth-2 packages)", () => {
      const root = setup();

      // Two sibling packages, same depth, no root tsconfig — scores will be
      // tight and the picker should fire.
      const pkgA = path.join(root, "packages", "pkg-a");
      const pkgB = path.join(root, "packages", "pkg-b");
      fs.mkdirSync(pkgA, { recursive: true });
      fs.mkdirSync(pkgB, { recursive: true });
      writeFile(path.join(pkgA, "tsconfig.json"), "{}");
      writeFile(path.join(pkgA, "package.json"), JSON.stringify({ name: "pkg-a" }));
      writeFile(path.join(pkgA, "src", "a.ts"), "");
      writeFile(path.join(pkgB, "tsconfig.json"), "{}");
      writeFile(path.join(pkgB, "package.json"), JSON.stringify({ name: "pkg-b" }));
      writeFile(path.join(pkgB, "src", "b.ts"), "");

      const result = selectPickerCandidates(root);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      const paths = result!.map((c) => path.basename(path.dirname(c.path)));
      expect(paths.sort()).toEqual(["pkg-a", "pkg-b"]);
    });

    it("annotates each candidate with the nearest package.json name", () => {
      const root = setup();
      const pkgA = path.join(root, "packages", "pkg-a");
      const pkgB = path.join(root, "packages", "pkg-b");
      fs.mkdirSync(pkgA, { recursive: true });
      fs.mkdirSync(pkgB, { recursive: true });
      writeFile(path.join(pkgA, "tsconfig.json"), "{}");
      writeFile(path.join(pkgA, "package.json"), JSON.stringify({ name: "@scope/pkg-a" }));
      writeFile(path.join(pkgB, "tsconfig.json"), "{}");
      writeFile(path.join(pkgB, "package.json"), JSON.stringify({ name: "@scope/pkg-b" }));

      const result = selectPickerCandidates(root);
      expect(result).not.toBeNull();
      const names = result!.map((c) => c.projectName).sort();
      expect(names).toEqual(["@scope/pkg-a", "@scope/pkg-b"]);
    });
  });

  describe("promptPicker", () => {
    it("defaults to candidate #1 on bare Enter", async () => {
      const root = setup();
      const candidates = [
        {
          path: path.join(root, "a", "tsconfig.json"),
          score: 100,
          depth: 1,
          isComposite: false,
          fileCount: 5,
          projectName: "a",
        },
        {
          path: path.join(root, "b", "tsconfig.json"),
          score: 100,
          depth: 1,
          isComposite: false,
          fileCount: 5,
          projectName: "b",
        },
      ];
      const stdin = makeMockStdin("\n");
      const out = makeMockStdout();

      const picked = await promptPicker(candidates, root, {
        input: stdin,
        output: out.stream,
      });

      expect(picked).toBe(candidates[0]);
      expect(out.captured).toContain("Multiple tsconfig.json found");
    });

    it("returns the candidate at the chosen index (1-based)", async () => {
      const root = setup();
      const candidates = [
        {
          path: path.join(root, "a", "tsconfig.json"),
          score: 100,
          depth: 1,
          isComposite: false,
          fileCount: 5,
          projectName: "a",
        },
        {
          path: path.join(root, "b", "tsconfig.json"),
          score: 100,
          depth: 1,
          isComposite: false,
          fileCount: 5,
          projectName: "b",
        },
      ];
      const stdin = makeMockStdin("2\n");
      const out = makeMockStdout();

      const picked = await promptPicker(candidates, root, {
        input: stdin,
        output: out.stream,
      });

      expect(picked).toBe(candidates[1]);
    });

    it("falls back to #1 on invalid input", async () => {
      const root = setup();
      const candidates = [
        {
          path: path.join(root, "a", "tsconfig.json"),
          score: 100,
          depth: 1,
          isComposite: false,
          fileCount: 5,
          projectName: "a",
        },
        {
          path: path.join(root, "b", "tsconfig.json"),
          score: 100,
          depth: 1,
          isComposite: false,
          fileCount: 5,
          projectName: "b",
        },
      ];
      const stdin = makeMockStdin("99\n");
      const out = makeMockStdout();

      const picked = await promptPicker(candidates, root, {
        input: stdin,
        output: out.stream,
      });

      expect(picked).toBe(candidates[0]);
      expect(out.captured).toContain("invalid selection");
    });
  });
});
