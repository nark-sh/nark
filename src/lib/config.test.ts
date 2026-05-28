/**
 * Tests — per-repo .nark/config.json + legacy .narkrc.json reader (qt-162).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

async function freshConfigModule() {
  vi.resetModules();
  return await import("./config.js");
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("config.readRepoWorkspace (qt-162)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];
  let repoDir: string;

  beforeEach(() => {
    repoDir = path.join(os.tmpdir(), `nark-config-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(repoDir, { recursive: true });
    stderrLines = [];
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: any) => {
        stderrLines.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmDir(repoDir);
  });

  it("reads .nark/config.json workspace field", async () => {
    fs.mkdirSync(path.join(repoDir, ".nark"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".nark", "config.json"),
      JSON.stringify({ workspace: "team-a" }),
    );
    const config = await freshConfigModule();
    const result = config.readRepoWorkspace(repoDir);
    expect(result).toEqual({ slug: "team-a", source: "config" });
  });

  it("falls back to .narkrc.json when .nark/config.json absent", async () => {
    fs.writeFileSync(
      path.join(repoDir, ".narkrc.json"),
      JSON.stringify({ workspace: "team-b" }),
    );
    const config = await freshConfigModule();
    const result = config.readRepoWorkspace(repoDir);
    expect(result).toEqual({ slug: "team-b", source: "narkrc" });
    // No warning when only legacy file present
    const conflictLines = stderrLines.filter((l) =>
      l.includes("Found both"),
    );
    expect(conflictLines.length).toBe(0);
  });

  it("when BOTH present at same dir: returns config value AND emits one-time warning", async () => {
    fs.mkdirSync(path.join(repoDir, ".nark"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".nark", "config.json"),
      JSON.stringify({ workspace: "team-canonical" }),
    );
    fs.writeFileSync(
      path.join(repoDir, ".narkrc.json"),
      JSON.stringify({ workspace: "team-legacy" }),
    );
    const config = await freshConfigModule();

    const result1 = config.readRepoWorkspace(repoDir);
    expect(result1).toEqual({ slug: "team-canonical", source: "config" });

    // Second call should NOT re-emit the conflict warning
    config.readRepoWorkspace(repoDir);

    const conflictLines = stderrLines.filter((l) =>
      l.includes("Found both"),
    );
    expect(conflictLines.length).toBe(1);
  });

  it("returns null when neither file present in tree", async () => {
    const config = await freshConfigModule();
    const result = config.readRepoWorkspace(repoDir);
    expect(result).toBeNull();
  });

  it("walks up to parent dirs to find config", async () => {
    const childDir = path.join(repoDir, "src", "lib");
    fs.mkdirSync(childDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".nark"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".nark", "config.json"),
      JSON.stringify({ workspace: "parent-ws" }),
    );
    const config = await freshConfigModule();
    const result = config.readRepoWorkspace(childDir);
    expect(result).toEqual({ slug: "parent-ws", source: "config" });
  });
});
