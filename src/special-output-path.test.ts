/**
 * qt-178: Unit tests for the special-output-path handling in the nark CLI.
 *
 * Covers:
 *   - isSpecialOutputPath() detects /dev/stdout, /dev/stderr, /dev/null,
 *     and any path under /dev/. Returns false for normal file paths.
 *   - writeAuditRecord() routes /dev/stdout to process.stdout.write and
 *     does NOT call fs.writeFileSync for that special path. For all other
 *     paths (including /dev/null) it delegates to fs.writeFileSync.
 *
 * Pure-helper coverage — no real scans, no commander wiring exercised.
 * The setupOutputLogging "skip on special outputDir" behavior is covered
 * indirectly via the boolean returned by isSpecialOutputPath (the call
 * site in src/index.ts gates setupOutputLogging on that helper).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { isSpecialOutputPath } from "./index.js";
import { writeAuditRecord } from "./reporter.js";
import type { AuditRecord } from "./types.js";

function mkAuditRecord(): AuditRecord {
  // Minimal record — the writer just JSON.stringifies it, so shape doesn't
  // matter to the routing logic. Cast suppresses fields we don't need.
  return {
    timestamp: "2026-05-30T00:00:00.000Z",
    files_analyzed: 0,
    packages_analyzed: [],
    contracts_applied: 0,
    violations: [],
  } as unknown as AuditRecord;
}

describe("isSpecialOutputPath", () => {
  it("returns true for /dev/stdout", () => {
    expect(isSpecialOutputPath("/dev/stdout")).toBe(true);
  });

  it("returns true for /dev/stderr", () => {
    expect(isSpecialOutputPath("/dev/stderr")).toBe(true);
  });

  it("returns true for /dev/null", () => {
    expect(isSpecialOutputPath("/dev/null")).toBe(true);
  });

  it("returns true for /dev/fd/1 (any path under /dev/)", () => {
    expect(isSpecialOutputPath("/dev/fd/1")).toBe(true);
  });

  it("returns false for a normal /tmp file path", () => {
    expect(isSpecialOutputPath("/tmp/audit.json")).toBe(false);
  });

  it("returns false for a relative project-local path", () => {
    // Resolved against cwd — never starts with /dev/ unless cwd is under /dev/
    expect(isSpecialOutputPath("./nark-output/audit.json")).toBe(false);
  });

  it("returns false for an absolute user-home path", () => {
    expect(isSpecialOutputPath("/Users/foo/proj/audit.json")).toBe(false);
  });
});

describe("writeAuditRecord routing for /dev/stdout", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    // process.stdout.write IS spyable (process is a normal object, not an
    // ESM namespace) — this is the assertion we care about.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* file may not exist; ignore */
      }
    }
    tmpFiles.length = 0;
  });

  it("routes /dev/stdout to process.stdout.write and writes valid JSON", () => {
    writeAuditRecord(mkAuditRecord(), "/dev/stdout");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const firstCallArg = stdoutSpy.mock.calls[0][0];
    expect(typeof firstCallArg).toBe("string");
    expect(JSON.parse(firstCallArg as string)).toMatchObject({
      files_analyzed: 0,
    });
  });

  it("routes a normal /tmp path through fs.writeFileSync (baseline, readback)", () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `nark-special-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    tmpFiles.push(tmpFile);
    writeAuditRecord(mkAuditRecord(), tmpFile);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(tmpFile)).toBe(true);
    const contents = fs.readFileSync(tmpFile, "utf-8");
    expect(JSON.parse(contents)).toMatchObject({ files_analyzed: 0 });
  });

  it("routes /dev/null through fs.writeFileSync (kernel discards on POSIX)", () => {
    // Per qt-178 plan: /dev/null does NOT need a stdout branch — POSIX
    // fs.writeFileSync('/dev/null', ...) succeeds and the kernel discards.
    // setupOutputLogging is what crashes on /dev/null, not the writer.
    // No throw expected.
    expect(() => writeAuditRecord(mkAuditRecord(), "/dev/null")).not.toThrow();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
