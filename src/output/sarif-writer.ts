/**
 * SARIF 2.1.0 output writer for nark scan results.
 *
 * Converts nark Violation objects into a SARIF log that can be consumed by
 * GitHub Advanced Security, VS Code SARIF Viewer, and other SARIF-aware tooling.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Violation } from '../types.js';

// ---------------------------------------------------------------------------
// SARIF type shapes (minimal — only what we produce)
// ---------------------------------------------------------------------------

interface SarifArtifactLocation {
  uri: string;
}

interface SarifRegion {
  startLine: number;
  startColumn: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

interface SarifMessage {
  text: string;
}

interface SarifShortDescription {
  text: string;
}

interface SarifRule {
  id: string;
  name: string;
  helpUri?: string;
  shortDescription: SarifShortDescription;
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: SarifMessage;
  locations: SarifLocation[];
}

interface SarifToolDriver {
  name: string;
  version: string;
  rules: SarifRule[];
}

interface SarifTool {
  driver: SarifToolDriver;
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
}

interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

function toSarifLevel(severity: Violation['severity']): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'note';
    default:
      return 'warning';
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a SARIF 2.1.0 log from an array of nark violations and either write
 * it to a file or emit it to stdout.
 *
 * @param violations - Array of Violation objects from the scan
 * @param outputPath - Optional file path. When omitted, output goes to stdout.
 */
export function writeSarifOutput(violations: Violation[], outputPath?: string): void {
  // Deduplicate rules — one rule entry per unique ruleId, first violation wins
  const ruleMap = new Map<string, Violation>();
  for (const v of violations) {
    const ruleId = `${v.package}/${v.contract_clause}`;
    if (!ruleMap.has(ruleId)) {
      ruleMap.set(ruleId, v);
    }
  }

  const rules: SarifRule[] = Array.from(ruleMap.entries()).map(([ruleId, v]) => ({
    id: ruleId,
    name: ruleId,
    helpUri: v.source_doc || undefined,
    shortDescription: {
      text: v.description,
    },
  }));

  const results: SarifResult[] = violations.map((v) => {
    const ruleId = `${v.package}/${v.contract_clause}`;
    // Convert absolute path to relative URI from cwd
    const relPath = path.relative(process.cwd(), v.file);
    // Normalise Windows backslashes to forward slashes for SARIF URIs
    const uri = relPath.split(path.sep).join('/');

    return {
      ruleId,
      level: toSarifLevel(v.severity),
      message: {
        text: v.description,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri,
            },
            region: {
              startLine: v.line,
              startColumn: v.column,
            },
          },
        },
      ],
    };
  });

  const sarifLog: SarifLog = {
    $schema:
      'https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0-rtm.5.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'nark',
            version: '0.1.0',
            rules,
          },
        },
        results,
      },
    ],
  };

  const json = JSON.stringify(sarifLog, null, 2) + '\n';

  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, json, 'utf-8');
  } else {
    process.stdout.write(json);
  }
}
