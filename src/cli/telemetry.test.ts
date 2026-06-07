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
