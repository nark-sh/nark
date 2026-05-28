/**
 * Tests — v2 multi-workspace credentials model + resolveActiveWorkspace (qt-162).
 *
 * Strategy: instead of mocking fs, we use a temporary $HOME redirect via the
 * NARK_HOME env override (auth.ts reads HOME via os.homedir()). For simplicity
 * here, we mock os.homedir() to point at a per-test tmpdir, and exercise the
 * real fs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_HOME = path.join(os.tmpdir(), `nark-auth-test-${process.pid}`);

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

const NARK_DIR = path.join(TEST_HOME, ".nark");
const V1_PATH = path.join(NARK_DIR, "credentials");
const V2_PATH = path.join(NARK_DIR, "credentials.json");

async function freshAuthModule() {
  vi.resetModules();
  return await import("./auth.js");
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function writeV1(creds: {
  token: string;
  email: string;
  orgName: string;
  plan: string;
}): void {
  fs.mkdirSync(NARK_DIR, { recursive: true });
  fs.writeFileSync(V1_PATH, JSON.stringify(creds), "utf-8");
}

function readV2(): any {
  return JSON.parse(fs.readFileSync(V2_PATH, "utf-8"));
}

describe("auth v2 (qt-162)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];

  beforeEach(() => {
    rmDir(NARK_DIR);
    stderrLines = [];
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: any) => {
        stderrLines.push(String(chunk));
        return true;
      });
    delete process.env.NARK_API_KEY;
    delete process.env.NARK_TOKEN;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmDir(NARK_DIR);
  });

  describe("v1 → v2 migration", () => {
    it("migrates v1 credentials file with single stderr note and sets migratedAt", async () => {
      writeV1({
        token: "v1-token-xyz",
        email: "user@example.com",
        orgName: "Old Org",
        plan: "pro",
      });
      const auth = await freshAuthModule();

      const v2 = auth.readCredentialsV2();
      expect(v2).not.toBeNull();
      expect(v2!.version).toBe(2);
      expect(v2!.default).toBe("default");
      expect(v2!.workspaces["default"]).toMatchObject({
        token: "v1-token-xyz",
        email: "user@example.com",
        orgName: "Old Org",
        plan: "pro",
      });
      expect(v2!.migratedAt).toBeDefined();
      expect(typeof v2!.migratedAt).toBe("string");

      // Stderr note printed exactly once
      const noteLines = stderrLines.filter((l) =>
        l.includes("Migrated nark credentials to v2"),
      );
      expect(noteLines.length).toBe(1);

      // V2 file written, V1 file removed
      expect(fs.existsSync(V2_PATH)).toBe(true);
      expect(fs.existsSync(V1_PATH)).toBe(false);
    });

    it("does NOT re-emit migration note on subsequent reads (migratedAt suppresses)", async () => {
      writeV1({
        token: "v1-token",
        email: "user@example.com",
        orgName: "Org",
        plan: "pro",
      });
      const auth = await freshAuthModule();

      auth.readCredentialsV2(); // migrate
      stderrLines = []; // reset

      auth.readCredentialsV2(); // second read
      const noteLines = stderrLines.filter((l) =>
        l.includes("Migrated nark credentials to v2"),
      );
      expect(noteLines.length).toBe(0);
    });

    it("ignores v1 file when v2 file already exists", async () => {
      fs.mkdirSync(NARK_DIR, { recursive: true });
      fs.writeFileSync(
        V2_PATH,
        JSON.stringify({
          version: 2,
          default: "existing",
          workspaces: {
            existing: {
              token: "v2-token",
              orgId: "org-1",
              orgSlug: "existing",
              orgName: "Existing",
              email: "e@example.com",
              plan: "pro",
              loggedInAt: new Date().toISOString(),
            },
          },
        }),
      );
      writeV1({
        token: "v1-old",
        email: "old@x.com",
        orgName: "Old",
        plan: "free",
      });
      const auth = await freshAuthModule();

      const v2 = auth.readCredentialsV2();
      expect(v2!.default).toBe("existing");
      expect(v2!.workspaces["existing"].token).toBe("v2-token");
      const noteLines = stderrLines.filter((l) =>
        l.includes("Migrated"),
      );
      expect(noteLines.length).toBe(0);
    });
  });

  describe("resolution priority", () => {
    async function setupStore(workspaces: Record<string, any>, defaultSlug: string | null = null) {
      fs.mkdirSync(NARK_DIR, { recursive: true });
      fs.writeFileSync(
        V2_PATH,
        JSON.stringify({
          version: 2,
          default: defaultSlug,
          workspaces,
        }),
      );
      return await freshAuthModule();
    }

    const wsA = {
      token: "token-a",
      orgId: "id-a",
      orgSlug: "team-a",
      orgName: "Team A",
      email: "a@example.com",
      plan: "team",
      loggedInAt: "2026-01-01T00:00:00.000Z",
    };
    const wsB = {
      token: "token-b",
      orgId: "id-b",
      orgSlug: "team-b",
      orgName: "Team B",
      email: "b@example.com",
      plan: "team",
      loggedInAt: "2026-02-01T00:00:00.000Z",
    };
    const wsC = {
      token: "token-c",
      orgId: "id-c",
      orgSlug: "team-c",
      orgName: "Team C",
      email: "c@example.com",
      plan: "solo",
      loggedInAt: "2026-03-01T00:00:00.000Z",
    };

    it("step 1: NARK_API_KEY env var wins over everything", async () => {
      process.env.NARK_API_KEY = "env-key";
      const auth = await setupStore({ "team-a": wsA }, "team-a");
      const r = auth.resolveActiveWorkspace();
      expect(r).toEqual({ token: "env-key", source: "env" });
    });

    it("step 2: NARK_TOKEN env var fires deprecation warning ONCE per process", async () => {
      process.env.NARK_TOKEN = "legacy-token";
      const auth = await setupStore({ "team-a": wsA }, "team-a");

      const r1 = auth.resolveActiveWorkspace();
      expect(r1?.token).toBe("legacy-token");
      expect(r1?.source).toBe("env");

      const r2 = auth.resolveActiveWorkspace();
      expect(r2?.token).toBe("legacy-token");

      const deprecationLines = stderrLines.filter((l) =>
        l.includes("NARK_TOKEN is deprecated"),
      );
      expect(deprecationLines.length).toBe(1);
    });

    it("step 3: opts.orgSlug flag selects workspace by slug", async () => {
      const auth = await setupStore(
        { "team-a": wsA, "team-b": wsB },
        "team-a",
      );
      const r = auth.resolveActiveWorkspace({ orgSlug: "team-b" });
      expect(r?.token).toBe("token-b");
      expect(r?.source).toBe("flag");
      expect(r?.workspace?.orgSlug).toBe("team-b");
    });

    it("step 4: .nark/config.json workspace field selects workspace", async () => {
      const auth = await setupStore(
        { "team-a": wsA, "team-b": wsB },
        "team-a",
      );
      // Write per-repo config in a tmp dir
      const repoDir = path.join(os.tmpdir(), `nark-repo-${process.pid}-config`);
      try {
        fs.mkdirSync(path.join(repoDir, ".nark"), { recursive: true });
        fs.writeFileSync(
          path.join(repoDir, ".nark", "config.json"),
          JSON.stringify({ workspace: "team-b" }),
        );
        const r = auth.resolveActiveWorkspace({ cwd: repoDir });
        expect(r?.token).toBe("token-b");
        expect(r?.source).toBe("config");
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("step 5: legacy .narkrc.json workspace field selects workspace (no warning)", async () => {
      const auth = await setupStore(
        { "team-a": wsA, "team-c": wsC },
        "team-a",
      );
      const repoDir = path.join(os.tmpdir(), `nark-repo-${process.pid}-rc`);
      try {
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(
          path.join(repoDir, ".narkrc.json"),
          JSON.stringify({ workspace: "team-c" }),
        );
        const r = auth.resolveActiveWorkspace({ cwd: repoDir });
        expect(r?.token).toBe("token-c");
        expect(r?.source).toBe("narkrc");
        const conflictLines = stderrLines.filter((l) =>
          l.includes("Found both"),
        );
        expect(conflictLines.length).toBe(0);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("step 6: both .nark/config.json and .narkrc.json — config wins, ONE conflict warning", async () => {
      const auth = await setupStore(
        { "team-a": wsA, "team-b": wsB, "team-c": wsC },
        "team-a",
      );
      const repoDir = path.join(os.tmpdir(), `nark-repo-${process.pid}-both`);
      try {
        fs.mkdirSync(path.join(repoDir, ".nark"), { recursive: true });
        fs.writeFileSync(
          path.join(repoDir, ".nark", "config.json"),
          JSON.stringify({ workspace: "team-b" }),
        );
        fs.writeFileSync(
          path.join(repoDir, ".narkrc.json"),
          JSON.stringify({ workspace: "team-c" }),
        );
        const r1 = auth.resolveActiveWorkspace({ cwd: repoDir });
        expect(r1?.token).toBe("token-b");
        expect(r1?.source).toBe("config");

        // Call again — warning is one-time per process
        auth.resolveActiveWorkspace({ cwd: repoDir });

        const conflictLines = stderrLines.filter((l) =>
          l.includes("Found both"),
        );
        expect(conflictLines.length).toBe(1);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("step 7: credentials.json default field selects workspace", async () => {
      const auth = await setupStore(
        { "team-a": wsA, "team-b": wsB },
        "team-a",
      );
      const r = auth.resolveActiveWorkspace();
      expect(r?.token).toBe("token-a");
      expect(r?.source).toBe("default");
    });

    it("step 8: single workspace, no default field — source 'single'", async () => {
      const auth = await setupStore({ "solo-org": wsA }, null);
      const r = auth.resolveActiveWorkspace();
      expect(r?.token).toBe("token-a");
      expect(r?.source).toBe("single");
    });

    it("step 9: empty store, no env — returns null", async () => {
      const auth = await freshAuthModule();
      const r = auth.resolveActiveWorkspace();
      expect(r).toBeNull();
    });
  });

  describe("removeWorkspace auto-promote", () => {
    async function setupTwoWorkspaces() {
      fs.mkdirSync(NARK_DIR, { recursive: true });
      fs.writeFileSync(
        V2_PATH,
        JSON.stringify({
          version: 2,
          default: "team-a",
          workspaces: {
            "team-a": {
              token: "token-a",
              orgId: "id-a",
              orgSlug: "team-a",
              orgName: "Team A",
              email: "a@x.com",
              plan: "team",
              loggedInAt: "2026-01-01T00:00:00.000Z",
            },
            "team-b": {
              token: "token-b",
              orgId: "id-b",
              orgSlug: "team-b",
              orgName: "Team B",
              email: "b@x.com",
              plan: "team",
              loggedInAt: "2026-02-01T00:00:00.000Z",
            },
          },
        }),
      );
      return await freshAuthModule();
    }

    it("removes default and auto-promotes max-loggedInAt workspace", async () => {
      const auth = await setupTwoWorkspaces();
      const result = auth.removeWorkspace("team-a");
      expect(result.newDefault).toBe("team-b");
      expect(result.deleted).toBe(true);

      const v2 = readV2();
      expect(v2.default).toBe("team-b");
      expect(v2.workspaces["team-a"]).toBeUndefined();

      const stderr = stderrLines.join("");
      expect(stderr).toMatch(/Default workspace is now team-b/);
    });

    it("removes solo workspace, deletes file, no auto-promote", async () => {
      fs.mkdirSync(NARK_DIR, { recursive: true });
      fs.writeFileSync(
        V2_PATH,
        JSON.stringify({
          version: 2,
          default: "team-a",
          workspaces: {
            "team-a": {
              token: "token-a",
              orgId: "id-a",
              orgSlug: "team-a",
              orgName: "Team A",
              email: "a@x.com",
              plan: "team",
              loggedInAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      );
      const auth = await freshAuthModule();
      const result = auth.removeWorkspace("team-a");
      expect(result.newDefault).toBeNull();
      expect(fs.existsSync(V2_PATH)).toBe(false);
    });

    it("removeAllWorkspaces deletes the file", async () => {
      const auth = await setupTwoWorkspaces();
      auth.removeAllWorkspaces();
      expect(fs.existsSync(V2_PATH)).toBe(false);
    });
  });

  describe("renameWorkspace", () => {
    async function setupStore() {
      fs.mkdirSync(NARK_DIR, { recursive: true });
      fs.writeFileSync(
        V2_PATH,
        JSON.stringify({
          version: 2,
          default: "old",
          workspaces: {
            old: {
              token: "tok",
              orgId: "id-old",
              orgSlug: "old",
              orgName: "Old Name",
              email: "a@x.com",
              plan: "pro",
              loggedInAt: "2026-01-01T00:00:00.000Z",
            },
            existing: {
              token: "tok2",
              orgId: "id-ex",
              orgSlug: "existing",
              orgName: "Existing",
              email: "b@x.com",
              plan: "free",
              loggedInAt: "2026-02-01T00:00:00.000Z",
            },
          },
        }),
      );
      return await freshAuthModule();
    }

    it("renames slug and updates default reference", async () => {
      const auth = await setupStore();
      auth.renameWorkspace("old", "new-slug");
      const v2 = readV2();
      expect(v2.workspaces.old).toBeUndefined();
      expect(v2.workspaces["new-slug"]).toMatchObject({
        token: "tok",
        orgSlug: "new-slug",
      });
      expect(v2.default).toBe("new-slug");
    });

    it("throws when new slug already exists", async () => {
      const auth = await setupStore();
      expect(() => auth.renameWorkspace("old", "existing")).toThrow(
        /already exists/,
      );
    });
  });
});
