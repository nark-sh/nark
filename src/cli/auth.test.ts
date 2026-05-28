/**
 * Tests — qt-164 login branching, login-result rendering, pre-scan
 * workspace-mismatch warning, and the post-scan footer predicate.
 *
 * Strategy: mock `os.homedir()` to a per-test tmpdir (matches the pattern
 * established in src/lib/auth.test.ts), exercise real fs for credentials v2
 * + `.nark/config.json` writes, and spy on console.log / process.stderr.write
 * to capture rendered output.
 *
 * The poll loop itself isn't tested here — we only test the pure decision
 * helper (`decideLoginBranch`) and the renderer (`printLoginResult`)
 * extracted from the loginAction post-poll branch, plus the pre-scan
 * warning + footer predicate from src/lib/pre-scan-warning.ts.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_HOME = path.join(os.tmpdir(), `nark-cli-auth-test-${process.pid}`);

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

const NARK_DIR = path.join(TEST_HOME, ".nark");
const V2_PATH = path.join(NARK_DIR, "credentials.json");

function rmDir(d: string): void {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Build an ephemeral cwd directory. Plants `.git` so readRepoWorkspace stops
 * its ancestor walk inside the tmpdir (prevents accidentally hitting a real
 * `.nark/config.json` somewhere up the host filesystem).
 *
 * When `withConfig` is provided, writes either `.nark/config.json` (canonical)
 * or `.narkrc.json` (legacy) with `{ workspace: <slug> }`.
 */
function makeTempCwd(
  name: string,
  withConfig?: { workspace: string },
  configKind: "config" | "narkrc" = "config",
): string {
  const dir = path.join(os.tmpdir(), `nark-cli-cwd-${process.pid}-${name}`);
  rmDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (withConfig) {
    if (configKind === "config") {
      fs.mkdirSync(path.join(dir, ".nark"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".nark", "config.json"),
        JSON.stringify(withConfig),
      );
    } else {
      fs.writeFileSync(
        path.join(dir, ".narkrc.json"),
        JSON.stringify(withConfig),
      );
    }
  }
  return dir;
}

// ---------------------------------------------------------------------------
// decideLoginBranch — pure decision helper
// ---------------------------------------------------------------------------

describe("decideLoginBranch (qt-164)", () => {
  beforeEach(() => {
    rmDir(NARK_DIR);
  });

  it("returns branch=first when existing is null", async () => {
    const { decideLoginBranch } = await import("./auth.js");
    const cwd = makeTempCwd("first-null");
    const result = decideLoginBranch(null, "new-org", cwd);
    expect(result.branch).toBe("first");
    expect(result.oldDefaultName).toBeNull();
  });

  it("returns branch=first when existing has no default", async () => {
    const { decideLoginBranch } = await import("./auth.js");
    const cwd = makeTempCwd("first-nodef");
    const result = decideLoginBranch(
      { default: null, workspaces: {} },
      "new-org",
      cwd,
    );
    expect(result.branch).toBe("first");
    expect(result.oldDefaultName).toBeNull();
  });

  it("returns branch=same-slug when current default === newSlug", async () => {
    const { decideLoginBranch } = await import("./auth.js");
    const cwd = makeTempCwd("same");
    const existing = {
      default: "foo",
      workspaces: { foo: { orgName: "Foo Org" } },
    };
    const result = decideLoginBranch(existing, "foo", cwd);
    expect(result.branch).toBe("same-slug");
    expect(result.oldDefaultName).toBe("Foo Org");
  });

  it("returns branch=multi-config when slug differs and .nark/config.json exists in cwd", async () => {
    const { decideLoginBranch } = await import("./auth.js");
    const cwd = makeTempCwd("multi-config", { workspace: "foo" });
    const existing = {
      default: "foo",
      workspaces: { foo: { orgName: "Foo Org" } },
    };
    const result = decideLoginBranch(existing, "bar", cwd);
    expect(result.branch).toBe("multi-config");
    expect(result.oldDefaultName).toBe("Foo Org");
  });

  it("returns branch=multi-config when legacy .narkrc.json exists", async () => {
    const { decideLoginBranch } = await import("./auth.js");
    const cwd = makeTempCwd("multi-narkrc", { workspace: "foo" }, "narkrc");
    const existing = {
      default: "foo",
      workspaces: { foo: { orgName: "Foo Org" } },
    };
    const result = decideLoginBranch(existing, "bar", cwd);
    expect(result.branch).toBe("multi-config");
  });

  it("returns branch=auto-promote when slug differs and no binding anywhere", async () => {
    const { decideLoginBranch } = await import("./auth.js");
    const cwd = makeTempCwd("auto");
    const existing = {
      default: "foo",
      workspaces: { foo: { orgName: "Foo Org" } },
    };
    const result = decideLoginBranch(existing, "bar", cwd);
    expect(result.branch).toBe("auto-promote");
    expect(result.oldDefaultName).toBe("Foo Org");
  });

  it("falls back oldDefaultName to slug when workspace entry is missing", async () => {
    const { decideLoginBranch } = await import("./auth.js");
    const cwd = makeTempCwd("orphan-default");
    // Default points at a slug that's not in workspaces (degenerate but
    // possible after partial corruption). Should fall back to the slug.
    const existing = { default: "ghost", workspaces: {} };
    const result = decideLoginBranch(existing, "bar", cwd);
    expect(result.branch).toBe("auto-promote");
    expect(result.oldDefaultName).toBe("ghost");
  });
});

// ---------------------------------------------------------------------------
// printLoginResult — renderer
// ---------------------------------------------------------------------------

describe("printLoginResult (qt-164)", () => {
  let stdoutLines: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutLines = [];
    stdoutSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        stdoutLines.push(args.map((a) => String(a)).join(" "));
      });
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("same-slug → one line containing 'Token refreshed for'", async () => {
    const { printLoginResult } = await import("./auth.js");
    printLoginResult("same-slug", "Foo Org", "foo", "u@e.com", "Foo Org", "foo");
    expect(stdoutLines.length).toBe(1);
    expect(stdoutLines[0]).toContain("Token refreshed for Foo Org");
    // Must NOT contain a switch hint or "Logged in to" preamble.
    expect(stdoutLines[0]).not.toContain("Logged in to");
    expect(stdoutLines[0]).not.toContain("nark workspace use");
  });

  it("multi-config → 5 lines including 'still' and 'To switch default:'", async () => {
    const { printLoginResult } = await import("./auth.js");
    printLoginResult(
      "multi-config",
      "Bar Org",
      "bar",
      "u@e.com",
      "Foo Org",
      "foo",
    );
    expect(stdoutLines.length).toBe(5);
    const joined = stdoutLines.join("\n");
    expect(joined).toContain("Logged in to Bar Org (bar). Token saved.");
    expect(joined).toContain("Your default workspace is still Foo Org (foo)");
    expect(joined).toContain("To list all workspaces:");
    expect(joined).toContain("To switch default:");
    expect(joined).toContain("nark workspace use bar");
    // Must NOT auto-promote.
    expect(joined).not.toContain("Default workspace switched to");
  });

  it("auto-promote → 2 lines including 'Default workspace switched to'", async () => {
    const { printLoginResult } = await import("./auth.js");
    printLoginResult(
      "auto-promote",
      "Bar Org",
      "bar",
      "u@e.com",
      "Foo Org",
      "foo",
    );
    expect(stdoutLines.length).toBe(2);
    const joined = stdoutLines.join("\n");
    expect(joined).toContain("Logged in to Bar Org (bar) as u@e.com");
    expect(joined).toContain("Default workspace switched to Bar Org (bar)");
  });

  it("first → one line containing 'Logged in to' with no extra hint", async () => {
    const { printLoginResult } = await import("./auth.js");
    printLoginResult("first", "Bar Org", "bar", "u@e.com", null, null);
    expect(stdoutLines.length).toBe(1);
    expect(stdoutLines.join("\n")).toContain(
      "Logged in to Bar Org (bar) as u@e.com",
    );
  });
});

// ---------------------------------------------------------------------------
// maybePrintPreScanWorkspaceWarning — DEC6 (5-min delta + slug-differs + no-binding)
// ---------------------------------------------------------------------------

describe("maybePrintPreScanWorkspaceWarning (qt-164)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];

  beforeEach(() => {
    rmDir(NARK_DIR);
    stderrChunks = [];
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    rmDir(NARK_DIR);
  });

  function writeV2(
    defaultSlug: string,
    workspaces: Record<
      string,
      { orgName: string; loggedInAt: string; email?: string }
    >,
  ) {
    fs.mkdirSync(NARK_DIR, { recursive: true });
    const v2 = {
      version: 2,
      default: defaultSlug,
      workspaces: Object.fromEntries(
        Object.entries(workspaces).map(([slug, w]) => [
          slug,
          {
            token: `tok-${slug}`,
            orgId: `org-${slug}`,
            orgSlug: slug,
            orgName: w.orgName,
            email: w.email ?? "u@e.com",
            plan: "free",
            loggedInAt: w.loggedInAt,
          },
        ]),
      ),
    };
    fs.writeFileSync(V2_PATH, JSON.stringify(v2), "utf-8");
  }

  it("fires when delta < 5min, slugs differ, no binding", async () => {
    vi.resetModules();
    const { maybePrintPreScanWorkspaceWarning } = await import(
      "../lib/pre-scan-warning.js"
    );
    const now = Date.parse("2026-05-28T12:00:00Z");
    writeV2("foo", {
      foo: {
        orgName: "Foo Org",
        loggedInAt: new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago
      },
      bar: {
        orgName: "Bar Org",
        loggedInAt: new Date(now - 60 * 1000).toISOString(), // 1m ago
      },
    });
    const cwd = makeTempCwd("warning-fires");
    maybePrintPreScanWorkspaceWarning({ cwd, now: () => now });
    const out = stderrChunks.join("");
    expect(out).toContain("You recently logged into Bar Org");
    expect(out).toContain("but this scan will go to Foo Org");
    expect(out).toContain("nark workspace use bar");
  });

  it("does NOT fire when delta >= 5min", async () => {
    vi.resetModules();
    const { maybePrintPreScanWorkspaceWarning } = await import(
      "../lib/pre-scan-warning.js"
    );
    const now = Date.parse("2026-05-28T12:00:00Z");
    writeV2("foo", {
      foo: {
        orgName: "Foo Org",
        loggedInAt: new Date(now - 60 * 60 * 1000).toISOString(),
      },
      bar: {
        orgName: "Bar Org",
        loggedInAt: new Date(now - 6 * 60 * 1000).toISOString(), // 6m ago
      },
    });
    const cwd = makeTempCwd("warning-too-old");
    maybePrintPreScanWorkspaceWarning({ cwd, now: () => now });
    expect(stderrChunks.join("")).toBe("");
  });

  it("does NOT fire when mostRecent slug === default", async () => {
    vi.resetModules();
    const { maybePrintPreScanWorkspaceWarning } = await import(
      "../lib/pre-scan-warning.js"
    );
    const now = Date.parse("2026-05-28T12:00:00Z");
    writeV2("foo", {
      foo: {
        orgName: "Foo Org",
        loggedInAt: new Date(now - 30 * 1000).toISOString(),
      },
      bar: {
        orgName: "Bar Org",
        loggedInAt: new Date(now - 60 * 60 * 1000).toISOString(),
      },
    });
    const cwd = makeTempCwd("warning-default-most-recent");
    maybePrintPreScanWorkspaceWarning({ cwd, now: () => now });
    expect(stderrChunks.join("")).toBe("");
  });

  it("does NOT fire when .nark/config.json binding exists in cwd", async () => {
    vi.resetModules();
    const { maybePrintPreScanWorkspaceWarning } = await import(
      "../lib/pre-scan-warning.js"
    );
    const now = Date.parse("2026-05-28T12:00:00Z");
    writeV2("foo", {
      foo: {
        orgName: "Foo Org",
        loggedInAt: new Date(now - 60 * 60 * 1000).toISOString(),
      },
      bar: {
        orgName: "Bar Org",
        loggedInAt: new Date(now - 60 * 1000).toISOString(),
      },
    });
    const cwd = makeTempCwd("warning-bound", { workspace: "foo" });
    maybePrintPreScanWorkspaceWarning({ cwd, now: () => now });
    expect(stderrChunks.join("")).toBe("");
  });

  it("does NOT fire when credentials v2 file is absent", async () => {
    vi.resetModules();
    const { maybePrintPreScanWorkspaceWarning } = await import(
      "../lib/pre-scan-warning.js"
    );
    const cwd = makeTempCwd("warning-no-creds");
    maybePrintPreScanWorkspaceWarning({ cwd });
    expect(stderrChunks.join("")).toBe("");
  });

  it("does NOT fire when there is only one workspace", async () => {
    vi.resetModules();
    const { maybePrintPreScanWorkspaceWarning } = await import(
      "../lib/pre-scan-warning.js"
    );
    const now = Date.parse("2026-05-28T12:00:00Z");
    writeV2("foo", {
      foo: {
        orgName: "Foo Org",
        loggedInAt: new Date(now - 60 * 1000).toISOString(),
      },
    });
    const cwd = makeTempCwd("warning-single-ws");
    maybePrintPreScanWorkspaceWarning({ cwd, now: () => now });
    expect(stderrChunks.join("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// shouldPrintScanUploadedFooter — DEC1 predicate
// ---------------------------------------------------------------------------

describe("shouldPrintScanUploadedFooter (qt-164)", () => {
  it("returns true when result.sent && workspace is defined", async () => {
    const { shouldPrintScanUploadedFooter } = await import(
      "../lib/pre-scan-warning.js"
    );
    expect(
      shouldPrintScanUploadedFooter(
        { sent: true },
        { orgName: "Foo", orgSlug: "foo" },
      ),
    ).toBe(true);
  });

  it("returns false when result.sent is false", async () => {
    const { shouldPrintScanUploadedFooter } = await import(
      "../lib/pre-scan-warning.js"
    );
    expect(
      shouldPrintScanUploadedFooter(
        { sent: false },
        { orgName: "Foo", orgSlug: "foo" },
      ),
    ).toBe(false);
  });

  it("returns false when result is undefined (telemetry disabled)", async () => {
    const { shouldPrintScanUploadedFooter } = await import(
      "../lib/pre-scan-warning.js"
    );
    expect(
      shouldPrintScanUploadedFooter(undefined, {
        orgName: "Foo",
        orgSlug: "foo",
      }),
    ).toBe(false);
  });

  it("returns false when workspace is undefined (env-token user)", async () => {
    const { shouldPrintScanUploadedFooter } = await import(
      "../lib/pre-scan-warning.js"
    );
    expect(shouldPrintScanUploadedFooter({ sent: true }, undefined)).toBe(
      false,
    );
  });
});
