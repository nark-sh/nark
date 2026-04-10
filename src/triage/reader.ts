/**
 * Read existing triage data from .nark/violations/
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TriageVerdict {
  verdict: 'true-positive' | 'false-positive' | 'wont-fix' | 'untriaged';
  reason: string;
  triaged_by: string;
  triaged_at: string;
}

/**
 * Scan .nark/violations/ recursively, read all .json files,
 * extract fingerprint + triage verdict.
 * Returns map of fingerprint → triage data.
 */
export function readTriageData(narkDir: string): Map<string, TriageVerdict> {
  const result = new Map<string, TriageVerdict>();
  const violationsDir = path.join(narkDir, 'violations');

  if (!fs.existsSync(violationsDir)) {
    return result;
  }

  try {
    const packages = fs.readdirSync(violationsDir);
    for (const pkg of packages) {
      const pkgDir = path.join(violationsDir, pkg);
      try {
        if (!fs.statSync(pkgDir).isDirectory()) continue;
        const files = fs.readdirSync(pkgDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(pkgDir, file);
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.fingerprint && data.triage) {
              const triage = data.triage;
              result.set(data.fingerprint, {
                verdict: triage.verdict || 'untriaged',
                reason: triage.reason || '',
                triaged_by: triage.triaged_by || '',
                triaged_at: triage.triaged_at || '',
              });
            }
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // Skip unreadable package dirs
      }
    }
  } catch {
    // Violations dir unreadable
  }

  return result;
}

/**
 * Read all violation JSON files from .nark/violations/, returning
 * each file's full data along with its path on disk.
 */
export function readAllViolationFiles(narkDir: string): Array<{ filePath: string; data: any }> {
  const results: Array<{ filePath: string; data: any }> = [];
  const violationsDir = path.join(narkDir, 'violations');

  if (!fs.existsSync(violationsDir)) {
    return results;
  }

  try {
    const packages = fs.readdirSync(violationsDir);
    for (const pkg of packages) {
      const pkgDir = path.join(violationsDir, pkg);
      try {
        if (!fs.statSync(pkgDir).isDirectory()) continue;
        const files = fs.readdirSync(pkgDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(pkgDir, file);
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            results.push({ filePath, data });
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // Skip unreadable package dirs
      }
    }
  } catch {
    // Violations dir unreadable
  }

  return results;
}
