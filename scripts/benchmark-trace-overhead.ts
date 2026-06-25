#!/usr/bin/env tsx
/**
 * Benchmark — scan-time + JSON-size overhead for Phase 01 (detection-trace
 * + convention-mining + lineage).
 *
 * Wave 5 runs this script TWICE — once on main HEAD (the baseline captured
 * by Wave 0 and committed alongside this script) and once on the PR branch
 * carrying the full Phase 01 diff. The medians are compared and must stay
 * within the Phase 01 success budget (<=5% scan-time, <=20% JSON-size).
 *
 * Usage:
 *   npx tsx scripts/benchmark-trace-overhead.ts \
 *     --target=<path-to-tsconfig> \
 *     --corpus=<corpus-path>[,<second-tier>,...] \
 *     [--runs=5]
 *
 * Output:
 *   - Writes a JSON blob to STDOUT (the Wave 5 comparison script reads
 *     this from the wrapper that captures stdout).
 *   - Each run drops a per-run object inside `samples[]` and surfaces
 *     p25 / p50 / p75 percentiles for both scan_time_ms and
 *     json_size_bytes.
 *
 * Multi-corpus per .claude/rules/multi-corpus.md: --corpus accepts a
 * comma-separated list. The first tier listed wins on profile precedence
 * (mirrors loadMultipleCorpora() in src/corpus-loader.ts). Wave 5
 * comparison runs MUST pass the same value to both invocations so the
 * delta reflects code change, not corpus tier composition.
 */

import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { loadMultipleCorpora } from "../src/corpus-loader.js";
import { UniversalAnalyzer } from "../src/v2/analyzer.js";
import { ThrowingFunctionDetector } from "../src/v2/plugins/throwing-function-detector.js";
import { PropertyChainDetector } from "../src/v2/plugins/property-chain-detector.js";
import { EventListenerDetector } from "../src/v2/plugins/event-listener-detector.js";
import { EventListenerAbsencePlugin } from "../src/v2/plugins/event-listener-absence.js";
import { InstanceTrackerPlugin } from "../src/v2/plugins/instance-tracker.js";
import type { PackageContract } from "../src/types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ──────────────────────────────────────────────────────────────────────────────

interface Args {
  targetTsconfig: string;
  corpusPaths: string[];
  runs: number;
}

function parseArgs(argv: string[]): Args {
  let target: string | undefined;
  let corpus: string | undefined;
  let runs = 5;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--target=")) target = arg.slice("--target=".length);
    else if (arg.startsWith("--corpus="))
      corpus = arg.slice("--corpus=".length);
    else if (arg.startsWith("--runs=")) runs = Number(arg.slice("--runs=".length));
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!target) {
    console.error("ERROR: --target=<tsconfig-path> is required");
    printHelp();
    process.exit(2);
  }
  if (!corpus) {
    console.error("ERROR: --corpus=<corpus-path>[,...] is required");
    printHelp();
    process.exit(2);
  }
  if (!Number.isFinite(runs) || runs < 1) {
    console.error("ERROR: --runs must be a positive integer");
    process.exit(2);
  }

  return {
    targetTsconfig: path.resolve(target),
    corpusPaths: corpus.split(",").map((p) => path.resolve(p.trim())),
    runs,
  };
}

function printHelp(): void {
  console.error(
    [
      "benchmark-trace-overhead — Phase 01 scan-time + JSON-size baseline",
      "",
      "Usage:",
      "  npx tsx scripts/benchmark-trace-overhead.ts \\",
      "    --target=<tsconfig.json-path> \\",
      "    --corpus=<corpus-path>[,<second-tier>,...] \\",
      "    [--runs=5]",
      "",
      "Output: JSON to stdout with samples[] + p25/p50/p75 percentiles.",
    ].join("\n"),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Percentile helper (linear interpolation)
// ──────────────────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ──────────────────────────────────────────────────────────────────────────────
// Single-run scanner invocation (re-creates analyzer per run so warm-cache
// effects don't bias the measurement)
// ──────────────────────────────────────────────────────────────────────────────

async function singleRun(args: Args): Promise<{
  scanTimeMs: number;
  jsonSizeBytes: number;
  violationCount: number;
}> {
  // Load all corpus tiers (matches CLI multi-corpus behavior).
  const corpusResult = await loadMultipleCorpora(args.corpusPaths);
  const contracts: Map<string, PackageContract> = corpusResult.contracts;

  // Build detection maps from contracts (mirror harness.ts / api-v2.ts).
  const factoryToPackage = new Map<string, string>();
  const classToPackage = new Map<string, string>();
  const typeToPackage = new Map<string, string>();
  const promiseFactoryToPackage = new Map<string, string>();
  const instanceChainMethodToPackage = new Map<string, string>();

  for (const [packageName, contract] of contracts.entries()) {
    const detection = (contract as PackageContract).detection;
    if (!detection) continue;
    for (const cls of detection.class_names || [])
      classToPackage.set(cls, packageName);
    for (const factory of detection.factory_methods || [])
      factoryToPackage.set(factory, packageName);
    for (const typeName of detection.type_names || [])
      typeToPackage.set(typeName, packageName);
    for (const method of detection.promise_factory_methods || [])
      promiseFactoryToPackage.set(method, packageName);
    for (const method of detection.instance_chain_methods || [])
      instanceChainMethodToPackage.set(method, packageName);
  }

  const instanceTracker = new InstanceTrackerPlugin(
    factoryToPackage,
    classToPackage,
    typeToPackage,
    promiseFactoryToPackage,
    instanceChainMethodToPackage,
  );

  const analyzer = new UniversalAnalyzer(
    {
      tsConfigPath: args.targetTsconfig,
      corpusPath: args.corpusPaths[args.corpusPaths.length - 1],
    },
    contracts,
  );

  analyzer.registerPlugin(instanceTracker);
  analyzer.registerPlugin(new ThrowingFunctionDetector(instanceTracker));
  analyzer.registerPlugin(new PropertyChainDetector(instanceTracker));
  analyzer.registerPlugin(new EventListenerDetector());
  analyzer.registerPlugin(new EventListenerAbsencePlugin(contracts));

  analyzer.initialize();

  const start = performance.now();
  const result = analyzer.analyze();
  const scanTimeMs = performance.now() - start;

  // JSON size = the violation surface a downstream consumer (SaaS DB,
  // SARIF, audit-record) actually carries. Sum across files; exclude
  // suppressed violations so a higher suppression rate doesn't shrink
  // the baseline artificially.
  const violations = result.files.flatMap((f) =>
    f.violations.filter((v) => !v.suppressed),
  );
  const jsonSizeBytes = Buffer.byteLength(JSON.stringify(violations), "utf-8");

  return {
    scanTimeMs,
    jsonSizeBytes,
    violationCount: violations.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(args.targetTsconfig)) {
    console.error(`ERROR: tsconfig not found at ${args.targetTsconfig}`);
    process.exit(2);
  }
  for (const corpusPath of args.corpusPaths) {
    if (!fs.existsSync(corpusPath)) {
      console.error(`ERROR: corpus tier not found at ${corpusPath}`);
      process.exit(2);
    }
  }

  const samples: Array<{
    run: number;
    scan_time_ms: number;
    json_size_bytes: number;
    violation_count: number;
  }> = [];

  for (let i = 1; i <= args.runs; i++) {
    const { scanTimeMs, jsonSizeBytes, violationCount } = await singleRun(args);
    samples.push({
      run: i,
      scan_time_ms: Math.round(scanTimeMs * 1000) / 1000,
      json_size_bytes: jsonSizeBytes,
      violation_count: violationCount,
    });
  }

  const scanTimes = samples.map((s) => s.scan_time_ms).sort((a, b) => a - b);
  const jsonSizes = samples.map((s) => s.json_size_bytes).sort((a, b) => a - b);

  const output = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    baseline_or_target: "baseline" as const,
    target_tsconfig: args.targetTsconfig,
    corpus_paths: args.corpusPaths,
    runs: args.runs,
    samples,
    scan_time_ms: {
      p25: percentile(scanTimes, 0.25),
      p50: percentile(scanTimes, 0.5),
      p75: percentile(scanTimes, 0.75),
    },
    json_size_bytes: {
      p25: percentile(jsonSizes, 0.25),
      p50: percentile(jsonSizes, 0.5),
      p75: percentile(jsonSizes, 0.75),
    },
    notes:
      "Wave 5 re-runs this script on the PR branch (baseline_or_target=target) " +
      "and compares medians. Budget: <=5% scan-time and <=20% json-size growth.",
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
