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

// ---------------------------------------------------------------------------
// Plan 01-12 / Wave 4c — fireConventionMatchRenderedEvent
// ---------------------------------------------------------------------------
//
// Best-effort firing of `conventionMatch_rendered` events to the SaaS
// /api/telemetry/convention-match endpoint added by Plan 01-11. CLI iterates
// scan-time violations, and fires one event per populated `conventionMatch`.
// MUST honor the existing telemetry opt-outs (NARK_TELEMETRY=off /
// DO_NOT_TRACK=1), MUST swallow network/HTTP failures, and MUST never throw.

function conventionPayload(
  overrides: Partial<{
    eventType: "rendered" | "resolved_with_recommended_pattern";
    patternId: string;
    matchRatio: number;
    siteCount: number;
    narkVersion: string;
  }> = {},
) {
  return {
    eventType: "rendered" as const,
    patternId: "try-catch:direct",
    matchRatio: 0.857,
    siteCount: 7,
    narkVersion: "test-1.0.0",
    ...overrides,
  };
}

describe("fireConventionMatchRenderedEvent (Plan 01-12 / Wave 4c)", () => {
  beforeEach(() => {
    rmDir(TEST_HOME);
    writeEnabledConfig();
    delete process.env["NARK_TELEMETRY"];
    delete process.env["DO_NOT_TRACK"];
    delete process.env["NARK_API_URL"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmDir(TEST_HOME);
    vi.resetModules();
  });

  it("opt-out: NARK_TELEMETRY=off short-circuits before any fetch", async () => {
    process.env["NARK_TELEMETRY"] = "off";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await fireConventionMatchRenderedEvent(conventionPayload());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt-out: DO_NOT_TRACK=1 short-circuits before any fetch", async () => {
    process.env["DO_NOT_TRACK"] = "1";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await fireConventionMatchRenderedEvent(conventionPayload());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt-out: file-config enabled=false short-circuits before any fetch", async () => {
    // Overwrite the enabled config so the telemetry file says enabled=false
    const dir = path.join(TEST_HOME, ".nark");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "telemetry.json"),
      JSON.stringify({ enabled: false, notified: true }),
    );

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await fireConventionMatchRenderedEvent(conventionPayload());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt-in: POSTs to /api/telemetry/convention-match with the expected payload", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          method: init.method ?? "GET",
          headers: (init.headers as Record<string, string>) ?? {},
          body: init.body as string,
        });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await fireConventionMatchRenderedEvent(conventionPayload());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    // Default base URL is https://app.nark.sh per project_telemetry_page_needed memory
    expect(calls[0]!.url).toBe(
      "https://app.nark.sh/api/telemetry/convention-match",
    );
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(calls[0]!.body);
    expect(parsed.eventType).toBe("rendered");
    expect(parsed.patternId).toBe("try-catch:direct");
    expect(parsed.matchRatio).toBe(0.857);
    expect(parsed.siteCount).toBe(7);
    expect(parsed.narkVersion).toBe("test-1.0.0");
  });

  it("respects opts.apiUrl override (NARK_API_URL dev override path)", async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push({ url });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await fireConventionMatchRenderedEvent(conventionPayload(), {
      apiUrl: "http://localhost:3000",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://localhost:3000/api/telemetry/convention-match",
    );
  });

  it("attaches bearer when opts.bearer is set", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({
          headers: (init.headers as Record<string, string>) ?? {},
        });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await fireConventionMatchRenderedEvent(conventionPayload(), {
      bearer: "bc_test_token",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer bc_test_token");
  });

  it("best-effort: fetch rejection does NOT throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    // Must complete (resolve) without throwing — never let telemetry break the scanner
    await expect(
      fireConventionMatchRenderedEvent(conventionPayload()),
    ).resolves.toBeUndefined();
  });

  it("best-effort: HTTP 429 (rate-limited) does NOT throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate limited" }),
      })) as unknown as typeof fetch,
    );

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await expect(
      fireConventionMatchRenderedEvent(conventionPayload()),
    ).resolves.toBeUndefined();
  });

  it("type sanity: accepts 'resolved_with_recommended_pattern' eventType (future v1.1)", async () => {
    // v1.0 CLI does NOT fire this event type per Plan 01-12 / Open Question #2.
    // The TYPE accepts it for symmetry with the SaaS endpoint's Zod schema
    // (which accepts both event types). This test just verifies the type signature
    // doesn't reject it — future v1.1 CLI side will fire it.
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ body: init.body as string });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchRenderedEvent } = await import("./telemetry.js");
    await fireConventionMatchRenderedEvent(
      conventionPayload({ eventType: "resolved_with_recommended_pattern" }),
    );

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]!.body);
    expect(parsed.eventType).toBe("resolved_with_recommended_pattern");
  });
});

// ---------------------------------------------------------------------------
// 2026-06-25 — fireConventionMatchBatch (per-scan batching)
// ---------------------------------------------------------------------------
//
// Replaces the per-violation fan-out of fireConventionMatchRenderedEvent with
// a single POST per scan shaped as { events: [...] }. Honors the same
// opt-outs and same swallow-everything posture; on top, an empty input is a
// guaranteed no-op so callers don't have to guard on length.

describe("fireConventionMatchBatch (2026-06-25 batching)", () => {
  beforeEach(() => {
    rmDir(TEST_HOME);
    writeEnabledConfig();
    delete process.env["NARK_TELEMETRY"];
    delete process.env["DO_NOT_TRACK"];
    delete process.env["NARK_API_URL"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmDir(TEST_HOME);
    vi.resetModules();
  });

  it("empty payloads array → no fetch fires (guard-free no-op)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt-out: NARK_TELEMETRY=off short-circuits before any fetch", async () => {
    process.env["NARK_TELEMETRY"] = "off";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch([conventionPayload(), conventionPayload()]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt-out: DO_NOT_TRACK=1 short-circuits before any fetch", async () => {
    process.env["DO_NOT_TRACK"] = "1";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch([conventionPayload()]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt-out: file-config enabled=false short-circuits before any fetch", async () => {
    const dir = path.join(TEST_HOME, ".nark");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "telemetry.json"),
      JSON.stringify({ enabled: false, notified: true }),
    );

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch([conventionPayload()]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("happy path: N payloads → exactly 1 POST with { events: [...] }", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          method: init.method ?? "GET",
          headers: (init.headers as Record<string, string>) ?? {},
          body: init.body as string,
        });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    const payloads = [
      conventionPayload({ patternId: "try-catch:direct" }),
      conventionPayload({ patternId: "result-type:err-then-ok" }),
      conventionPayload({ patternId: "log-then-rethrow" }),
    ];
    await fireConventionMatchBatch(payloads);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://app.nark.sh/api/telemetry/convention-match",
    );
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");

    const parsed = JSON.parse(calls[0]!.body);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0].patternId).toBe("try-catch:direct");
    expect(parsed.events[1].patternId).toBe("result-type:err-then-ok");
    expect(parsed.events[2].patternId).toBe("log-then-rethrow");
    expect(parsed.events[0].eventType).toBe("rendered");
  });

  it("large batch: 30 payloads → still exactly 1 POST (the whole point)", async () => {
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ body: init.body as string });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const payloads = Array.from({ length: 30 }, (_, i) =>
      conventionPayload({ patternId: `pattern-${i}` }),
    );
    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch(payloads);

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]!.body);
    expect(parsed.events).toHaveLength(30);
    expect(parsed.events[0].patternId).toBe("pattern-0");
    expect(parsed.events[29].patternId).toBe("pattern-29");
  });

  it("respects opts.apiUrl override (local-dev path)", async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push({ url });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch([conventionPayload()], {
      apiUrl: "http://localhost:3000",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://localhost:3000/api/telemetry/convention-match",
    );
  });

  it("attaches bearer when opts.bearer is set", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({
          headers: (init.headers as Record<string, string>) ?? {},
        });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch([conventionPayload()], {
      bearer: "bc_test_token",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer bc_test_token");
  });

  it("best-effort: fetch rejection does NOT throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await expect(
      fireConventionMatchBatch([conventionPayload()]),
    ).resolves.toBeUndefined();
  });

  it("best-effort: HTTP 429 (rate-limited) does NOT throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate limited" }),
      })) as unknown as typeof fetch,
    );

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await expect(
      fireConventionMatchBatch([conventionPayload()]),
    ).resolves.toBeUndefined();
  });

  it("payload-supplied repoFingerprint/deviceId override enrichment defaults", async () => {
    const calls: Array<{ body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ body: init.body as string });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const customFp =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const customDid = "11111111-2222-4333-8444-555555555555";

    const { fireConventionMatchBatch } = await import("./telemetry.js");
    await fireConventionMatchBatch([
      {
        ...conventionPayload(),
        repoFingerprint: customFp,
        deviceId: customDid,
      },
    ]);

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]!.body);
    expect(parsed.events[0].repoFingerprint).toBe(customFp);
    expect(parsed.events[0].deviceId).toBe(customDid);
  });
});
