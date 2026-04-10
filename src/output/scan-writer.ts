/**
 * Write scan results to .nark/ directory in the project root.
 *
 * Directory structure:
 *   .nark/
 *     config.yaml           — user configuration
 *     scans/
 *       001.json            — scan records (zero-padded 3-digit IDs)
 *       002.json
 *       latest -> 002.json  — symlink to latest scan
 *     violations/
 *       <package>/
 *         <fingerprint>.md  — human/AI-readable
 *         <fingerprint>.json — machine-readable
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Violation, AuditRecord } from '../types.js';
import { ensureConfig } from './config.js';
import { formatViolationMd, formatViolationJson } from './formatters.js';
import { computeViolationFingerprint } from '../suppressions/fingerprint.js';
import { getSuppressedFingerprints } from '../triage/suppressor.js';

export interface ScanRecord {
  id: string;
  timestamp: string;
  nark_version: string;
  tsconfig: string;
  duration_ms: number;
  summary: {
    total_violations: number;
    by_severity: Record<string, number>;
    packages_scanned: number;
    packages_with_violations: number;
    suppressed_count: number;
  };
  violations: Violation[];
}

export interface WriteScanOptions {
  projectRoot: string;
  auditRecord: AuditRecord;
  violations: Violation[];
  tsconfigPath: string;
  startTime: number;
  narkVersion?: string;
}

export interface WriteScanResult {
  narkDir: string;
  scanPath: string;
  scanId: string;
}

/**
 * Find the .nark/ directory for a project.
 * Uses the directory containing tsconfig.json as the project root.
 */
export function findNarkDir(projectRoot: string): string {
  return path.join(projectRoot, '.nark');
}

/**
 * Find the next available scan number.
 * Scans are named 001.json, 002.json, etc.
 */
function nextScanId(scansDir: string): string {
  if (!fs.existsSync(scansDir)) {
    return '001';
  }

  const entries = fs.readdirSync(scansDir);
  const scanNumbers = entries
    .filter(f => /^\d{3}\.json$/.test(f))
    .map(f => parseInt(f.replace('.json', ''), 10))
    .filter(n => !isNaN(n));

  if (scanNumbers.length === 0) {
    return '001';
  }

  const max = Math.max(...scanNumbers);
  return String(max + 1).padStart(3, '0');
}

/**
 * Update the `latest` symlink in scans directory.
 */
function updateLatestSymlink(scansDir: string, scanFilename: string): void {
  const latestPath = path.join(scansDir, 'latest');
  try {
    if (fs.existsSync(latestPath)) {
      fs.unlinkSync(latestPath);
    }
    fs.symlinkSync(scanFilename, latestPath);
  } catch {
    // Symlinks may fail on some systems (e.g., Windows without admin) — ignore
  }
}

/**
 * Write per-violation files under .nark/violations/<package>/.
 * Returns count of suppressed violations skipped.
 */
async function writeViolationFiles(
  narkDir: string,
  violations: Violation[],
  scanId: string,
  outputFormat: 'both' | 'md' | 'json'
): Promise<number> {
  if (violations.length === 0) return 0;

  // Load false-positive fingerprints to suppress
  const suppressed = getSuppressedFingerprints(narkDir);
  let suppressedCount = 0;

  const violationsDir = path.join(narkDir, 'violations');
  fs.mkdirSync(violationsDir, { recursive: true });

  for (const violation of violations) {
    const v = violation as any;
    // Compute fingerprint if not already set — ensures filename-safe hex hash
    let fingerprint: string = v.fingerprint;
    if (!fingerprint || fingerprint.includes(':') || fingerprint.includes('/')) {
      fingerprint = computeViolationFingerprint({
        packageName: violation.package,
        postconditionId: violation.contract_clause || violation.id,
        filePath: violation.file,
        lineNumber: violation.line,
        callExpression: violation.function || null,
      });
      v.fingerprint = fingerprint;
    }

    // Skip suppressed (false-positive) violations
    if (suppressed.has(fingerprint)) {
      suppressedCount++;
      continue;
    }

    // Package name may be scoped (e.g., @prisma/client) — use as-is for directory
    const pkgDir = path.join(violationsDir, violation.package);
    fs.mkdirSync(pkgDir, { recursive: true });

    const base = path.join(pkgDir, fingerprint);

    if (outputFormat === 'md' || outputFormat === 'both') {
      const md = formatViolationMd(violation, scanId);
      fs.writeFileSync(`${base}.md`, md, 'utf-8');
    }

    if (outputFormat === 'json' || outputFormat === 'both') {
      const json = formatViolationJson(violation, scanId);
      fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2), 'utf-8');
    }
  }

  return suppressedCount;
}

/**
 * Write scan results to .nark/ directory.
 * Returns paths so the CLI can print them to the user.
 * Never throws — wraps all I/O in try/catch and warns on failure.
 */
export async function writeScanResults(options: WriteScanOptions): Promise<WriteScanResult | null> {
  const { projectRoot, auditRecord, violations, tsconfigPath, startTime, narkVersion = '0.1.0' } = options;

  const narkDir = findNarkDir(projectRoot);

  try {
    // Ensure .nark/ exists and has config
    const config = ensureConfig(narkDir);

    const scansDir = path.join(narkDir, 'scans');
    fs.mkdirSync(scansDir, { recursive: true });

    const scanId = nextScanId(scansDir);
    const scanFilename = `${scanId}.json`;
    const scanPath = path.join(scansDir, scanFilename);

    const durationMs = Date.now() - startTime;

    // Count violations by severity
    const bySeverity: Record<string, number> = {};
    for (const v of violations) {
      const sev = v.severity.toUpperCase();
      bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    }

    // Count unique packages with violations
    const packagesWithViolations = new Set(violations.map(v => v.package)).size;

    const scanRecord: ScanRecord = {
      id: scanId,
      timestamp: new Date().toISOString(),
      nark_version: narkVersion,
      tsconfig: tsconfigPath,
      duration_ms: durationMs,
      summary: {
        total_violations: violations.length,
        by_severity: bySeverity,
        packages_scanned: auditRecord.packages_analyzed.length,
        packages_with_violations: packagesWithViolations,
        suppressed_count: 0,
      },
      violations,
    };

    fs.writeFileSync(scanPath, JSON.stringify(scanRecord, null, 2), 'utf-8');
    updateLatestSymlink(scansDir, scanFilename);

    // Write per-violation files (returns count of suppressed false-positives)
    const suppressedCount = await writeViolationFiles(narkDir, violations, scanId, config.output_format);

    // Update scan record with actual suppressed count
    if (suppressedCount > 0) {
      scanRecord.summary.suppressed_count = suppressedCount;
      fs.writeFileSync(scanPath, JSON.stringify(scanRecord, null, 2), 'utf-8');
      console.log(`Suppressed ${suppressedCount} false-positive violation${suppressedCount === 1 ? '' : 's'}`);
    }

    return { narkDir, scanPath, scanId };
  } catch (err) {
    // Non-fatal: warn but don't crash the scan
    console.warn(`Warning: Could not write .nark/ output: ${err}`);
    return null;
  }
}
