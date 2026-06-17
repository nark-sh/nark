/**
 * qt-179 — Pre-scan missing-node_modules detection.
 *
 * Tests use real temp directories (no fs mocks) — the function is pure-fs and
 * tmpdir tests run in milliseconds. Mirrors the test style of diff-filter.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

import { checkMissingNodeModules } from "./missing-node-modules-check.js";

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `nark-qt179-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

describe("checkMissingNodeModules", () => {
  const tmpRoots: string[] = [];

  beforeEach(() => {
    // nothing
  });

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const root = tmpRoots.pop()!;
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function setup(): string {
    const root = makeTmpDir();
    tmpRoots.push(root);
    return root;
  }

  it("returns ok when node_modules exists alongside package.json", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");
    fs.mkdirSync(path.join(root, "node_modules"));

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["axios", "stripe"],
    });

    expect(result.kind).toBe("ok");
  });

  it("returns missing when node_modules is absent and package.json declares a corpus-covered dep", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0", lodash: "^4.0.0" } }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["axios", "stripe"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      // packageJsonDir is whatever path.resolve() produced from the tsconfig
      // path's dirname — we don't dereference symlinks (no surprise paths).
      // On macOS /tmp is a symlink to /private/tmp; we just assert the
      // returned path resolves to the same inode as `root`.
      expect(fs.realpathSync(result.packageJsonDir)).toBe(
        fs.realpathSync(root),
      );
      expect(result.matchingDeps).toEqual(["axios"]);
    }
  });

  it("returns missing when only peerDependencies declares the corpus-covered dep", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ peerDependencies: { "@prisma/client": "^5.0.0" } }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["@prisma/client"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.matchingDeps).toEqual(["@prisma/client"]);
    }
  });

  it("returns missing when only devDependencies declares the corpus-covered dep", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ devDependencies: { stripe: "^14.0.0" } }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["stripe", "axios"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.matchingDeps).toEqual(["stripe"]);
    }
  });

  it("returns ok when package.json declares only packages NOT in the corpus name set", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { lodash: "^4.0.0", "some-internal-pkg": "^1.0.0" },
      }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");
    // No node_modules — but no corpus-covered deps either, so we should NOT warn.

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["axios", "stripe", "@prisma/client"],
    });

    expect(result.kind).toBe("ok");
  });

  it("returns ok when no package.json is found walking up from tsconfig dir", () => {
    // Place tsconfig somewhere with no ancestor package.json. os.tmpdir() on
    // macOS is typically /var/folders/... and walking up to / will not find
    // a package.json. We can't guarantee that for every machine, but we can
    // make this deterministic by pointing tsconfigPath at a brand-new tmp dir
    // *and* asserting based on whether the walk finds any package.json with
    // matching deps. To be fully deterministic we use a sub-sub dir under a
    // tmp root and rely on the fact that no package.json exists anywhere in
    // the chain we control. We accept that if some ancestor (e.g. /tmp) has a
    // package.json with matching deps, this test would change behavior — in
    // practice tmpdir ancestors never have such files.
    const root = setup();
    const deep = path.join(root, "no-pkg-anywhere", "sub", "deeper");
    fs.mkdirSync(deep, { recursive: true });
    writeFile(path.join(deep, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(deep, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    // Either "ok" because the walk found nothing in our controlled chain,
    // or — if the OS tmpdir's ancestor happens to have a package.json — at
    // least we don't crash. The contract we care about is "no throw, returns
    // an ok or missing object". Assert ok in the typical case.
    expect(result.kind).toBe("ok");
  });

  it("walks up multiple parents to find the nearest package.json", () => {
    const root = setup();
    // package.json + node_modules at root; tsconfig two levels deep.
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    fs.mkdirSync(path.join(root, "node_modules"));
    const deep = path.join(root, "packages", "app");
    fs.mkdirSync(deep, { recursive: true });
    writeFile(path.join(deep, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(deep, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    // node_modules exists at the discovered package.json dir → ok.
    expect(result.kind).toBe("ok");
  });

  it("matches @scope/name exactly (e.g. @prisma/client)", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          "@prisma/client": "^5.0.0",
          // A confounder that should NOT match
          "@prisma/engines": "^5.0.0",
        },
      }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["@prisma/client"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.matchingDeps).toEqual(["@prisma/client"]);
    }
  });

  it("sorts matchingDeps deterministically (for stable warning output)", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          stripe: "^14.0.0",
          axios: "^1.0.0",
        },
        devDependencies: {
          "@prisma/client": "^5.0.0",
        },
      }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["axios", "stripe", "@prisma/client"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      // Sorted ascending by default string comparison (@-scoped sorts first
      // because '@' (0x40) < 'a' (0x61)).
      expect(result.matchingDeps).toEqual([
        "@prisma/client",
        "axios",
        "stripe",
      ]);
    }
  });

  it("returns ok (does not throw) when package.json is malformed JSON", () => {
    const root = setup();
    writeFile(path.join(root, "package.json"), "{ this is not valid json");
    writeFile(path.join(root, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("ok");
  });

  // ─── Workspace-aware ancestor walk (spec Part A) ───────────────────────────

  it("returns ok when node_modules is at workspace root (pnpm-workspace.yaml)", () => {
    // packages/core has pkg.json declaring axios but no node_modules.
    // workspace root has pnpm-workspace.yaml and node_modules — deps are
    // hoisted there. The check should walk past the member pkg.json.
    const root = setup();
    writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "monorepo", private: true }),
    );
    fs.mkdirSync(path.join(root, "node_modules"));

    const memberDir = path.join(root, "packages", "core");
    fs.mkdirSync(memberDir, { recursive: true });
    writeFile(
      path.join(memberDir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    writeFile(path.join(memberDir, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(memberDir, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.resolvedNodeModules).toBeDefined();
      expect(fs.realpathSync(result.resolvedNodeModules!)).toBe(
        fs.realpathSync(path.join(root, "node_modules")),
      );
    }
  });

  it("returns ok when node_modules is at workspace root (lerna.json)", () => {
    const root = setup();
    writeFile(
      path.join(root, "lerna.json"),
      JSON.stringify({ packages: ["packages/*"] }),
    );
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "monorepo", private: true }),
    );
    fs.mkdirSync(path.join(root, "node_modules"));

    const memberDir = path.join(root, "packages", "app");
    fs.mkdirSync(memberDir, { recursive: true });
    writeFile(
      path.join(memberDir, "package.json"),
      JSON.stringify({ dependencies: { stripe: "^14.0.0" } }),
    );
    writeFile(path.join(memberDir, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(memberDir, "tsconfig.json"),
      corpusContractNames: ["stripe"],
    });

    expect(result.kind).toBe("ok");
  });

  it("returns ok when node_modules is at workspace root (npm/yarn workspaces field, array form)", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "monorepo",
        private: true,
        workspaces: ["packages/*"],
      }),
    );
    fs.mkdirSync(path.join(root, "node_modules"));

    const memberDir = path.join(root, "packages", "web");
    fs.mkdirSync(memberDir, { recursive: true });
    writeFile(
      path.join(memberDir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    writeFile(path.join(memberDir, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(memberDir, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("ok");
  });

  it("returns ok when node_modules is at workspace root (workspaces field, object form)", () => {
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "monorepo",
        private: true,
        workspaces: { packages: ["packages/*"], nohoist: ["**/foo"] },
      }),
    );
    fs.mkdirSync(path.join(root, "node_modules"));

    const memberDir = path.join(root, "packages", "web");
    fs.mkdirSync(memberDir, { recursive: true });
    writeFile(
      path.join(memberDir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    writeFile(path.join(memberDir, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(memberDir, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("ok");
  });

  it("returns missing with workspaceRoot when no node_modules at workspace root either", () => {
    // Member pkg.json declares axios; workspace marker present at root;
    // NO node_modules anywhere.
    const root = setup();
    writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "monorepo", private: true }),
    );

    const memberDir = path.join(root, "packages", "core");
    fs.mkdirSync(memberDir, { recursive: true });
    writeFile(
      path.join(memberDir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    writeFile(path.join(memberDir, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(memberDir, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.matchingDeps).toEqual(["axios"]);
      expect(result.workspaceMarkerType).toBe("pnpm-workspace.yaml");
      expect(result.workspaceRoot).not.toBeNull();
      expect(fs.realpathSync(result.workspaceRoot!)).toBe(
        fs.realpathSync(root),
      );
      // searchedPaths should include both the member and the workspace root.
      expect(result.searchedPaths.length).toBeGreaterThanOrEqual(2);
      const realSearched = result.searchedPaths.map((p) =>
        fs.realpathSync(path.dirname(p)),
      );
      expect(realSearched).toContain(fs.realpathSync(memberDir));
      expect(realSearched).toContain(fs.realpathSync(root));
    }
  });

  it("returns missing with workspaceRoot=null when no workspace marker is present", () => {
    // Single-package repo: pkg.json + missing node_modules.
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    writeFile(path.join(root, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(root, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.workspaceRoot).toBeNull();
      expect(result.workspaceMarkerType).toBeNull();
      expect(result.searchedPaths.length).toBeGreaterThan(0);
      // The first searched path is the package.json dir's node_modules.
      expect(fs.realpathSync(path.dirname(result.searchedPaths[0]))).toBe(
        fs.realpathSync(root),
      );
    }
  });

  it("returns ok when an intermediate dir has node_modules (no workspace marker)", () => {
    // Project layout:
    //   root/  (no pkg.json, no marker)
    //   root/app/  pkg.json + node_modules
    //   root/app/src/  tsconfig.json
    const root = setup();
    const appDir = path.join(root, "app");
    fs.mkdirSync(appDir);
    writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    fs.mkdirSync(path.join(appDir, "node_modules"));
    const srcDir = path.join(appDir, "src");
    fs.mkdirSync(srcDir);
    writeFile(path.join(srcDir, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(srcDir, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("ok");
  });

  it("stops walking at the workspace marker (does NOT pick up a node_modules above it)", () => {
    // Layout designed to prove the walk-bound:
    //   root/node_modules   ← we should NOT see this
    //   root/mono/pnpm-workspace.yaml  ← marker — walk stops here
    //   root/mono/package.json  ← workspace root pkg.json
    //   root/mono/packages/core/package.json  declares axios
    //   root/mono/packages/core/tsconfig.json
    // Since no node_modules under root/mono and the marker stops the walk,
    // we should report missing — not silently pick up root/node_modules.
    const root = setup();
    fs.mkdirSync(path.join(root, "node_modules"));

    const monoDir = path.join(root, "mono");
    fs.mkdirSync(monoDir);
    writeFile(
      path.join(monoDir, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    writeFile(
      path.join(monoDir, "package.json"),
      JSON.stringify({ name: "monorepo", private: true }),
    );

    const memberDir = path.join(monoDir, "packages", "core");
    fs.mkdirSync(memberDir, { recursive: true });
    writeFile(
      path.join(memberDir, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    writeFile(path.join(memberDir, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(memberDir, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("missing");
    if (result.kind === "missing") {
      expect(result.workspaceMarkerType).toBe("pnpm-workspace.yaml");
      // None of the searched paths should be the root/node_modules above the marker.
      // searchedPaths contains paths-as-strings (some won't exist on disk);
      // compare via the parent-dir realpath, which always exists.
      const realParentDirs = result.searchedPaths.map((p) =>
        fs.realpathSync(path.dirname(p)),
      );
      expect(realParentDirs).not.toContain(fs.realpathSync(root));
    }
  });

  it("bounds the walk at MAX_ANCESTOR_LEVELS when no workspace marker is found", () => {
    // Layout: a deep nested tsconfig, with pkg.json at depth 0 and
    // node_modules at depth 0. The walk should still find it because
    // MAX_ANCESTOR_LEVELS=4 and tsconfig is at depth 3 (parent of parent of parent).
    const root = setup();
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { axios: "^1.0.0" } }),
    );
    fs.mkdirSync(path.join(root, "node_modules"));

    // tsconfig at depth 3 — within bound.
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    writeFile(path.join(deep, "tsconfig.json"), "{}");

    const result = checkMissingNodeModules({
      tsconfigPath: path.join(deep, "tsconfig.json"),
      corpusContractNames: ["axios"],
    });

    expect(result.kind).toBe("ok");
  });
});
