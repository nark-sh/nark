/**
 * Programmatic API for verify-cli.
 * No side effects — no process.exit(), no console output, no file writes.
 * Designed for use as an imported module (e.g. from the SaaS web app).
 */

import * as path from "path";
import { loadCorpus } from "./corpus-loader.js";
import { Analyzer } from "./analyzer.js";
import type { AnalyzerConfig } from "./types.js";

export interface ScanOptions {
  /** Absolute path to tsconfig.json */
  tsconfigPath: string;
  /** Absolute path to corpus directory */
  corpusPath: string;
  /** Include test files in analysis (default: false) */
  includeTests?: boolean;
}

export interface ScanViolation {
  package: string;
  rule: string;
  severity: "ERROR" | "WARNING" | "INFO";
  message: string;
  location: {
    file: string;
    line: number;
    column?: number;
  };
  context?: {
    function?: string;
    snippet?: string;
  };
}

export interface ScanResult {
  violations: ScanViolation[];
  summary: {
    totalViolations: number;
    errorCount: number;
    warningCount: number;
    filesScanned: number;
  };
}

/**
 * Run a behavioral contract scan against a TypeScript project.
 * Throws on corpus load failure or analyzer error.
 */
export async function runScan(options: ScanOptions): Promise<ScanResult> {
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

  const config: AnalyzerConfig = {
    tsconfigPath,
    corpusPath,
    includeTests: options.includeTests ?? false,
  };

  const analyzer = new Analyzer(config, corpusResult.contracts);
  const violations = analyzer.analyze();
  const stats = analyzer.getStats();

  const errorCount = violations.filter((v) => v.severity === "error").length;
  const warningCount = violations.filter(
    (v) => v.severity === "warning",
  ).length;

  return {
    summary: {
      totalViolations: violations.length,
      errorCount,
      warningCount,
      filesScanned: stats.filesAnalyzed,
    },
    violations: violations.map((v) => ({
      package: v.package,
      rule: v.contract_clause,
      severity: v.severity.toUpperCase() as "ERROR" | "WARNING" | "INFO",
      message: v.description,
      location: {
        file: v.file,
        line: v.line,
        column: v.column || undefined,
      },
      context: {
        function: v.function,
        snippet: v.code_snippet?.lines.find((l) => l.highlighted)?.content,
      },
    })),
  };
}
