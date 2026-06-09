/**
 * Tests — qt-255 / S3-6: --telemetry-timeout flag and the underlying
 * fireTelemetryEvent / fireEnrichedTelemetryEvent timeout parameter.
 *
 * Strategy: stub global fetch with a controllable delay; pass a short
 * timeoutMs; assert the helpers return error:true, errorReason:"TIMEOUT"
 * without throwing. Also sanity-check the exported default constant so the
 * CLI default value and the helper default stay in lockstep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEST_HOME = path.join(os.tmpdir(), `nark-cli-tel-test-${process.pid}`);

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

function rmDir(d: string): void {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function writeEnabledConfig(): void {
  const dir = path.join(TEST_HOME, ".nark");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "telemetry.json"),
    JSON.stringify({ enabled: true, notified: true }),
  );
}

function basePayload() {
  return {
    version: "test",
    os: "darwin",
    arch: "arm64",
    nodeVersion: "v22.0.0",
    packageNames: ["axios"],
    contractIds: ["axios"],
    violationCountsByContract: { axios: 1 },
    scanDurationMs: 10,
    isCiMode: false,
  };
}

describe("DEFAULT_TELEMETRY_TIMEOUT_MS", () => {
  it("is 5000ms (bumped from 2000ms in qt-255)", async () => {
    const { DEFAULT_TELEMETRY_TIMEOUT_MS } = await import("./telemetry.js");
    expect(DEFAULT_TELEMETRY_TIMEOUT_MS).toBe(5000);
  });
});

describe("fireTelemetryEvent timeout (qt-255)", () => {
  beforeEach(() => {
    rmDir(TEST_HOME);
    writeEnabledConfig();
    delete process.env["NARK_TELEMETRY"];
    delete process.env["DO_NOT_TRACK"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmDir(TEST_HOME);
  });

  it("classifies aborted requests as TIMEOUT (errorReason)", async () => {
    // Stub fetch to honor the AbortSignal: reject with an AbortError when
    // the signal aborts. Real undici behaves the same.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "TimeoutError";
          reject(err);
        });
      });
    });

    const { fireTelemetryEvent } = await import("./telemetry.js");
    const result = await fireTelemetryEvent(basePayload(), 50);

    expect(result.sent).toBe(false);
    expect(result.error).toBe(true);
    expect(result.errorReason).toBe("TIMEOUT");
  });

  it("uses the default 5000ms when timeoutMs is omitted", async () => {
    // We can't introspect AbortSignal.timeout's deadline directly, so we
    // settle for: passing no override should resolve the success path on a
    // fast mock fetch (i.e. doesn't accidentally fall through to TIMEOUT).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );

    const { fireTelemetryEvent } = await import("./telemetry.js");
    const result = await fireTelemetryEvent(basePayload());

    expect(result.sent).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// S2-1 — endpoint-bound credentials + 401 anonymous fallback
// ---------------------------------------------------------------------------

function writeWorkspaceCreds(
  workspaces: Record<string, unknown>,
  defaultSlug: string,
): void {
  const dir = path.join(TEST_HOME, ".nark");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ version: 2, default: defaultSlug, workspaces }),
  );
}

function makeWorkspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: "bc_live_test_token",
    orgId: "org-test",
    orgSlug: "test-ws",
    orgName: "Test WS",
    email: "user@example.com",
    plan: "team",
    loggedInAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("fireEnrichedTelemetryEvent endpoint guards (S2-1)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];

  beforeEach(() => {
    rmDir(TEST_HOME);
    writeEnabledConfig();
    delete process.env["NARK_TELEMETRY"];
    delete process.env["DO_NOT_TRACK"];
    delete process.env["NARK_API_KEY"];
    delete process.env["NARK_TOKEN"];
    // Force the runtime API base to the prod default so explicit-mismatch
    // tests can store a localhost-endpoint workspace and assert the filter.
    delete process.env["NARK_API_URL"];

    stderrLines = [];
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrLines.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stderrSpy.mockRestore();
    rmDir(TEST_HOME);
    vi.resetModules();
  });

  it("explicit endpoint mismatch → token dropped, anonymous POST, stderr notice", async () => {
    // Stored workspace was minted against localhost. Runtime is the prod default.
    writeWorkspaceCreds(
      {
        "test-ws": makeWorkspace({
          token: "bc_local_token_xyz",
          endpoint: "http://localhost:3000",
        }),
      },
      "test-ws",
    );

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          headers: (init.headers as Record<string, string>) ?? {},
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      }) as unknown as typeof fetch,
    );

    const { fireTelemetryEvent, _resetStaleTokenNoticeForTests } =
      await import("./telemetry.js");
    _resetStaleTokenNoticeForTests();
    const result = await fireTelemetryEvent(basePayload());

    expect(result.sent).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/telemetry/scan");
    expect(calls[0]!.url).not.toContain("scan-enriched");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();

    const notice = stderrLines.find((l) =>
      l.includes("nark login expired or doesn't match this endpoint"),
    );
    expect(notice).toBeDefined();
  });

  it("legacy workspace + enriched 401 → anonymous fallback + stderr notice", async () => {
    // Workspace was created before nark@2.5.1 — endpoint field absent.
    writeWorkspaceCreds(
      {
        "test-ws": makeWorkspace({ token: "bc_legacy_token_xyz" }),
      },
      "test-ws",
    );

    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      status: number;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = (init.headers as Record<string, string>) ?? {};
        if (url.includes("scan-enriched")) {
          calls.push({ url, headers, status: 401 });
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: "Authentication required" }),
          };
        }
        calls.push({ url, headers, status: 200 });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireEnrichedTelemetryEvent, _resetStaleTokenNoticeForTests } =
      await import("./telemetry.js");
    _resetStaleTokenNoticeForTests();
    const result = await fireEnrichedTelemetryEvent(basePayload(), []);

    expect(result.sent).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.endpoint).toContain("/api/telemetry/scan");
    expect(result.endpoint).not.toContain("scan-enriched");

    // Two requests: enriched 401, then anonymous 200
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("scan-enriched");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer bc_legacy_token_xyz");
    expect(calls[1]!.url).not.toContain("scan-enriched");
    expect(calls[1]!.headers["Authorization"]).toBeUndefined();

    const notice = stderrLines.find((l) =>
      l.includes("nark login expired or doesn't match this endpoint"),
    );
    expect(notice).toBeDefined();
  });

  it("matching endpoint → token used on enriched endpoint, no notice", async () => {
    writeWorkspaceCreds(
      {
        "test-ws": makeWorkspace({
          token: "bc_prod_token_xyz",
          endpoint: "https://app.nark.sh",
        }),
      },
      "test-ws",
    );

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          headers: (init.headers as Record<string, string>) ?? {},
        });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireEnrichedTelemetryEvent, _resetStaleTokenNoticeForTests } =
      await import("./telemetry.js");
    _resetStaleTokenNoticeForTests();
    const result = await fireEnrichedTelemetryEvent(basePayload(), []);

    expect(result.sent).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("scan-enriched");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer bc_prod_token_xyz");

    const notice = stderrLines.find((l) =>
      l.includes("nark login expired or doesn't match this endpoint"),
    );
    expect(notice).toBeUndefined();
  });

  it("TelemetryResult.endpoint reflects the actual endpoint chosen (S2-2)", async () => {
    // After 401 fallback, the returned endpoint must be the anonymous one so
    // the verbose log in src/index.ts can render the truth.
    writeWorkspaceCreds(
      {
        "test-ws": makeWorkspace({ token: "bc_legacy" }),
      },
      "test-ws",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("scan-enriched")) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireEnrichedTelemetryEvent, _resetStaleTokenNoticeForTests } =
      await import("./telemetry.js");
    _resetStaleTokenNoticeForTests();
    const result = await fireEnrichedTelemetryEvent(basePayload(), []);

    expect(result.endpoint).not.toContain("scan-enriched");
    expect(result.endpoint).toMatch(/\/api\/telemetry\/scan$/);
  });
});
