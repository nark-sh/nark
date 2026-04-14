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
 * A scan record keyed by git commit hash, used by `nark ci` to persist and
 * compare scans across commits.
 */
export interface CommitScanRecord {
  gitCommit: string;           // full 40-char commit hash (or '' if unknown)
  timestamp: string;
  nark_version: string;
  tsconfig: string;
  violations: Violation[];     // violations with fingerprint already set
}

/**
 * Write a commit-keyed scan JSON to `.nark/scans/<gitCommit>.json`.
 * Used by `nark ci` to persist the current scan for future baseline reuse.
 *
 * Returns the written file path, or null on error.
 */
export function writeCommitScan(
  narkDir: string,
  gitCommit: string,
  violations: Violation[],
  tsconfigPath: string,
  narkVersion: string = '1.0.0'
): string | null {
  try {
    const scansDir = path.join(narkDir, 'scans');
    fs.mkdirSync(scansDir, { recursive: true });

    const record: CommitScanRecord = {
      gitCommit,
      timestamp: new Date().toISOString(),
      nark_version: narkVersion,
      tsconfig: tsconfigPath,
      violations,
    };

    const filePath = path.join(scansDir, `${gitCommit}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    return filePath;
  } catch (err) {
    console.warn(`Warning: Could not write commit scan to .nark/scans/: ${err}`);
    return null;
  }
}

/**
 * Load a commit-keyed scan from `.nark/scans/<gitCommit>.json`.
 * Returns null if not found or on parse error.
 */
export function loadCommitScan(narkDir: string, gitCommit: string): CommitScanRecord | null {
  try {
    const filePath = path.join(narkDir, 'scans', `${gitCommit}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as CommitScanRecord;
  } catch {
    return null;
  }
}

/**
 * Find the latest available scan from .nark/scans/.
 *
 * Preference order:
 *   1. Follow the 'latest' symlink if it exists and is a CommitScanRecord
 *   2. Walk numeric scan files (001.json, 002.json…) descending and wrap as CommitScanRecord
 *
 * Returns null if no scans exist.
 */
export function findLatestScan(narkDir: string): CommitScanRecord | null {
  const scansDir = path.join(narkDir, 'scans');
  if (!fs.existsSync(scansDir)) return null;

  // Try the 'latest' symlink first
  const latestLink = path.join(scansDir, 'latest');
  if (fs.existsSync(latestLink)) {
    try {
      const raw = fs.readFileSync(latestLink, 'utf-8');
      const parsed = JSON.parse(raw);
      // Could be a CommitScanRecord or a ScanRecord
      if (parsed.violations) {
        if (parsed.gitCommit !== undefined) {
          return parsed as CommitScanRecord;
        }
        // It's a ScanRecord — wrap it
        return {
          gitCommit: '',
          timestamp: parsed.timestamp ?? '',
          nark_version: parsed.nark_version ?? '0.1.0',
          tsconfig: parsed.tsconfig ?? '',
          violations: parsed.violations ?? [],
        };
      }
    } catch {
      // Fall through to numeric scan files
    }
  }

  // Walk numeric scan files descending
  try {
    const entries = fs.readdirSync(scansDir);
    const numericFiles = entries
      .filter(f => /^\d{3}\.json$/.test(f))
      .sort()
      .reverse(); // descending — highest number first

    for (const filename of numericFiles) {
      try {
        const raw = fs.readFileSync(path.join(scansDir, filename), 'utf-8');
        const parsed = JSON.parse(raw) as ScanRecord;
        if (parsed.violations) {
          return {
            gitCommit: '',
            timestamp: parsed.timestamp ?? '',
            nark_version: parsed.nark_version ?? '0.1.0',
            tsconfig: parsed.tsconfig ?? '',
            violations: parsed.violations ?? [],
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // readdirSync failed
  }

  return null;
}

/**
 * Write scan results to .nark/ directory.
 * Returns paths so the CLI can print them to the user.
 * Never throws — wraps all I/O in try/catch and warns on failure.
 */
export async function writeScanResults(options: WriteScanOptions): Promise<WriteScanResult | null> {
  const { projectRoot, auditRecord, violations, tsconfigPath, startTime, narkVersion = '1.0.0' } = options;

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
