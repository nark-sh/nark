/**
 * Programmatic API v2 — returns V2-native violation format.
 * No side effects (no process.exit, no console, no file writes).
 * Designed for use as an imported module (e.g. from the SaaS web app).
 */

import * as path from "path";
import { execSync } from "child_process";
import { loadCorpus } from "./corpus-loader.js";
import { PackageDiscovery } from "./package-discovery.js";
// Version inlined at build time — avoids runtime require("../package.json")
// which fails in Vercel Lambda (file not traced). Update when bumping package version.
const CLI_VERSION = "0.0.1";
import { UniversalAnalyzer } from "./v2/analyzer.js";
import { ThrowingFunctionDetector } from "./v2/plugins/throwing-function-detector.js";
import { PropertyChainDetector } from "./v2/plugins/property-chain-detector.js";
import { EventListenerDetector } from "./v2/plugins/event-listener-detector.js";
import { EventListenerAbsencePlugin } from "./v2/plugins/event-listener-absence.js";
import { ReturnValueChecker } from "./v2/plugins/return-value-checker.js";
import { InstanceTrackerPlugin } from "./v2/plugins/instance-tracker.js";
import type { Violation } from "./v2/types/index.js";

export type { Violation as V2Violation };

export interface ScanOptionsV2 {
  /** Absolute path to tsconfig.json */
  tsconfigPath: string;
  /** Absolute path to corpus directory */
  corpusPath: string;
}

export interface ScanResultV2 {
  violations: Violation[];
  cliVersion: string;
  gitDirty: boolean;
  packages: Array<{ name: string; callSiteCount: number }>;
  summary: {
    totalViolations: number;
    errorCount: number;
    warningCount: number;
    filesScanned: number;
  };
}

/**
 * Returns true if the working tree at repoRoot has uncommitted changes.
 * Returns false if git is unavailable or the path is not a git repo.
 */
export function isWorkingTreeDirty(repoRoot: string): boolean {
  try {
    const out = execSync("git status --porcelain", {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Run a behavioral contract scan against a TypeScript project using the V2 analyzer.
 * Returns V2-native violations directly (no V1 conversion).
 * Throws on corpus load failure or analyzer error.
 */
export async function runScanV2(options: ScanOptionsV2): Promise<ScanResultV2> {
  const tsconfigPath = path.resolve(options.tsconfigPath);
  const corpusPath = path.resolve(options.corpusPath);

  const corpusResult = await loadCorpus(corpusPath);

  if (corpusResult.errors.length > 0) {
    throw new Error(
      `Corpus load failed: ${corpusResult.errors.map((e: any) => e.message ?? String(e)).join(", ")}`,
    );
  }

  if (corpusResult.contracts.size === 0) {
    throw new Error("No contracts loaded from corpus");
  }

  const contracts = corpusResult.contracts;

  // Build detection maps from contracts (mirror adapter.ts pattern exactly)
  const factoryToPackage = new Map<string, string>();
  const classToPackage = new Map<string, string>();
  const typeToPackage = new Map<string, string>();

  for (const [packageName, contract] of contracts.entries()) {
    const detection = (contract as any).detection;
    if (!detection) continue;

    for (const cls of detection.class_names || []) {
      classToPackage.set(cls, packageName);
    }
    for (const factory of detection.factory_methods || []) {
      factoryToPackage.set(factory, packageName);
    }
    for (const typeName of detection.type_names || []) {
      typeToPackage.set(typeName, packageName);
    }
  }

  // Create shared instance tracker (consulted by other plugins)
  const instanceTracker = new InstanceTrackerPlugin(
    factoryToPackage,
    classToPackage,
    typeToPackage,
  );

  // NOTE: V2 AnalyzerConfig uses tsConfigPath (camelCase C), NOT tsconfigPath
  const analyzer = new UniversalAnalyzer(
    { tsConfigPath: tsconfigPath, corpusPath },
    contracts,
  );

  // Register plugins in order (InstanceTracker must come before plugins that use it)
  analyzer.registerPlugin(instanceTracker);
  analyzer.registerPlugin(new ThrowingFunctionDetector(instanceTracker));
  analyzer.registerPlugin(new PropertyChainDetector(instanceTracker));
  analyzer.registerPlugin(new EventListenerDetector());
  analyzer.registerPlugin(new EventListenerAbsencePlugin(contracts));
  analyzer.registerPlugin(new ReturnValueChecker());

  // Initialize and run
  analyzer.initialize();
  const result = analyzer.analyze();

  // Collect all violations across all files (skip suppressed)
  const violations: Violation[] = result.files
    .flatMap((f) => f.violations)
    .filter((v) => !v.suppressed);

  const errorCount = violations.filter((v) => v.severity === "error").length;
  const warningCount = violations.filter(
    (v) => v.severity === "warning",
  ).length;

  // Collect per-package call site counts via PackageDiscovery
  let packages: Array<{ name: string; callSiteCount: number }> = [];
  try {
    const projectRoot = path.dirname(tsconfigPath);
    const discovery = new PackageDiscovery(contracts);
    const discoveryResult = await discovery.discoverPackages(
      projectRoot,
      tsconfigPath,
    );
    packages = discoveryResult.packages.map((p) => ({
      name: p.name,
      callSiteCount: p.callSiteCount,
    }));
  } catch (err) {
    // PackageDiscovery failure is non-fatal — scan results still valid
    console.warn("[PackageDiscovery] Failed to collect call site counts:", err);
  }

  return {
    violations,
    cliVersion: CLI_VERSION,
    gitDirty: isWorkingTreeDirty(path.dirname(tsconfigPath)),
    packages,
    summary: {
      totalViolations: violations.length,
      errorCount,
      warningCount,
      filesScanned: result.filesAnalyzed,
    },
  };
}
