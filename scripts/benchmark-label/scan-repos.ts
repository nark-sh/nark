/**
 * Nark scan orchestrator for the offline benchmark-label flow.
 *
 * Reads shortlist.json (from rank-candidates.ts). For each repo, checks that
 * test-repos/<name>/ exists. Missing repos are logged and skipped — Caleb
 * may not have all 50 cloned. For each present repo:
 *   - runs `node nark-dev/nark/dist/index.js --tsconfig ... --corpus PRO,PUBLIC`
 *     per .claude/rules/cli-execution.md
 *   - parses violations JSON
 *   - for each violation, captures 40 lines of code context centered on the line
 *   - writes to ~/.nark/benchmark-label/violations/<repo>.json
 *
 * Usage: pnpm label:scan
 *
 * NO API calls, no secrets. Just runs nark against local checkouts.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { RepoCandidate, Shortlist, Violation } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // nark-dev/nark
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..', '..'); // behavioral-contracts

const NARK_BIN = path.join(REPO_ROOT, 'dist', 'index.js');
const CORPUS_PUBLIC = path.join(WORKSPACE_ROOT, 'nark-dev', 'nark-corpus');
const CORPUS_PRO = path.join(WORKSPACE_ROOT, 'nark-dev', 'nark-corpus-pro');
const TEST_REPOS_ROOT = path.join(WORKSPACE_ROOT, 'test-repos');

const SHORTLIST_PATH = path.join(
  WORKSPACE_ROOT,
  'work-packages',
  'accuracy-roadmap',
  'shortlist.json',
);
const STATE_DIR = path.join(os.homedir(), '.nark', 'benchmark-label');
const VIOLATIONS_DIR = path.join(STATE_DIR, 'violations');
const SCAN_OUTPUT_DIR = path.join(STATE_DIR, 'scan-outputs');

const CONTEXT_LINES_BEFORE = 20;
const CONTEXT_LINES_AFTER = 19;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corpusArg(): string {
  // Precedence per multi-corpus rule: pro > public. Only include tiers present.
  const tiers: string[] = [];
  if (fs.existsSync(CORPUS_PRO)) tiers.push(CORPUS_PRO);
  if (fs.existsSync(CORPUS_PUBLIC)) tiers.push(CORPUS_PUBLIC);
  return tiers.join(',');
}

function findTsconfig(repoPath: string): string | null {
  // Try common locations. Only picks the first one that exists.
  const candidates = [
    'tsconfig.json',
    'apps/web/tsconfig.json',
    'packages/web/tsconfig.json',
    'src/tsconfig.json',
  ];
  for (const c of candidates) {
    const p = path.join(repoPath, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readShortlist(): Shortlist {
  if (!fs.existsSync(SHORTLIST_PATH)) {
    throw new Error(
      `Shortlist not found at ${SHORTLIST_PATH}. Run 'pnpm label:rank' first.`,
    );
  }
  return JSON.parse(fs.readFileSync(SHORTLIST_PATH, 'utf-8')) as Shortlist;
}

function ensureDirs(): void {
  fs.mkdirSync(VIOLATIONS_DIR, { recursive: true });
  fs.mkdirSync(SCAN_OUTPUT_DIR, { recursive: true });
}

function readFileLines(filePath: string): string[] | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n');
  } catch {
    return null;
  }
}

function buildCodeSnippet(repoPath: string, relFile: string, line: number): string {
  const abs = path.join(repoPath, relFile);
  const lines = readFileLines(abs);
  if (!lines) return `<file not readable: ${relFile}>`;
  const from = Math.max(0, line - 1 - CONTEXT_LINES_BEFORE);
  const to = Math.min(lines.length, line + CONTEXT_LINES_AFTER);
  const slice = lines.slice(from, to);
  // Prefix with line numbers so the labeler can locate the call
  return slice
    .map((l, idx) => {
      const n = from + idx + 1;
      const marker = n === line ? '>' : ' ';
      return `${marker} ${String(n).padStart(4, ' ')} | ${l}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// nark spawn
// ---------------------------------------------------------------------------

interface RunNarkResult {
  ok: boolean;
  outputPath: string;
  stderr: string;
  exitCode: number | null;
}

function runNark(
  repo: RepoCandidate,
  tsconfig: string,
): Promise<RunNarkResult> {
  return new Promise((resolve) => {
    const outputPath = path.join(SCAN_OUTPUT_DIR, `${repo.name}-audit.json`);
    const args = [
      NARK_BIN,
      '--tsconfig',
      tsconfig,
      '--corpus',
      corpusArg(),
      '--output',
      outputPath,
    ];
    const child = spawn('node', args, {
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
        NARK_TELEMETRY: 'off',
        NARK_ALLOW_MISSING_DEPS: '1', // per cloud-scan-architecture.md
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.on('data', () => {
      // ignore stdout; --output writes the artifact
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0 && fs.existsSync(outputPath),
        outputPath,
        stderr,
        exitCode: code,
      });
    });
    child.on('error', () => {
      resolve({ ok: false, outputPath, stderr, exitCode: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Violations parser
// ---------------------------------------------------------------------------

interface NarkAuditRecord {
  violations?: Array<{
    file?: string;
    line?: number;
    packageName?: string;
    package?: string;
    ruleId?: string;
    rule_id?: string;
    postconditionId?: string;
    postcondition_id?: string;
    postconditionDescription?: string;
    postcondition_description?: string;
    description?: string;
    message?: string;
  }>;
  // Some versions nest per-package
  results?: Array<{
    package: string;
    violations: Array<Record<string, unknown>>;
  }>;
}

function parseAuditFile(auditPath: string): Array<Partial<Violation>> {
  const raw = JSON.parse(fs.readFileSync(auditPath, 'utf-8')) as NarkAuditRecord;
  const out: Array<Partial<Violation>> = [];

  if (Array.isArray(raw.violations)) {
    for (const v of raw.violations) {
      out.push({
        file: v.file || '',
        line: typeof v.line === 'number' ? v.line : 0,
        package: v.packageName || v.package || 'unknown',
        rule_id: v.ruleId || v.rule_id || 'unknown',
        postcondition_id: v.postconditionId || v.postcondition_id || 'unknown',
        postcondition_description:
          v.postconditionDescription ||
          v.postcondition_description ||
          v.description ||
          v.message ||
          '',
      });
    }
  }
  if (Array.isArray(raw.results)) {
    for (const r of raw.results) {
      for (const v of r.violations || []) {
        const vv = v as Record<string, unknown>;
        out.push({
          file: String(vv.file || ''),
          line: Number(vv.line || 0),
          package: r.package,
          rule_id: String(vv.ruleId || vv.rule_id || 'unknown'),
          postcondition_id: String(vv.postconditionId || vv.postcondition_id || 'unknown'),
          postcondition_description: String(
            vv.postconditionDescription ||
              vv.postcondition_description ||
              vv.description ||
              vv.message ||
              '',
          ),
        });
      }
    }
  }
  return out.filter((v) => v.file && v.line);
}

function violationId(repo: string, file: string, line: number, ruleId: string): string {
  return `${repo}:${file}:${line}:${ruleId}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Summary {
  repos_expected: number;
  repos_scanned: number;
  repos_skipped_missing: number;
  repos_skipped_no_tsconfig: number;
  repos_failed: number;
  total_violations: number;
}

async function main(): Promise<void> {
  ensureDirs();
  const shortlist = readShortlist();
  const selected = shortlist.repos.filter((r) => !r.reserve);
  console.log(`Read shortlist: ${selected.length} selected repos`);

  if (!fs.existsSync(NARK_BIN)) {
    console.error(`ERROR: nark not built. Missing ${NARK_BIN}`);
    console.error('  Run: pnpm build');
    process.exit(1);
  }

  const summary: Summary = {
    repos_expected: selected.length,
    repos_scanned: 0,
    repos_skipped_missing: 0,
    repos_skipped_no_tsconfig: 0,
    repos_failed: 0,
    total_violations: 0,
  };

  for (const repo of selected) {
    const absRepo = path.join(TEST_REPOS_ROOT, repo.name);
    if (!fs.existsSync(absRepo)) {
      console.log(`SKIP (missing on disk): ${repo.name}`);
      summary.repos_skipped_missing++;
      continue;
    }
    const tsconfig = findTsconfig(absRepo);
    if (!tsconfig) {
      console.log(`SKIP (no tsconfig): ${repo.name}`);
      summary.repos_skipped_no_tsconfig++;
      continue;
    }

    console.log(`SCAN: ${repo.name}`);
    const result = await runNark(repo, tsconfig);
    if (!result.ok) {
      console.log(
        `  FAILED (exit=${result.exitCode}): ${result.stderr.split('\n').slice(-3).join(' | ')}`,
      );
      summary.repos_failed++;
      continue;
    }

    const partial = parseAuditFile(result.outputPath);
    const violations: Violation[] = partial.map((p) => {
      const file = p.file || '';
      const line = p.line || 0;
      const rule_id = p.rule_id || 'unknown';
      return {
        repo: repo.name,
        file,
        line,
        package: p.package || 'unknown',
        rule_id,
        postcondition_id: p.postcondition_id || 'unknown',
        postcondition_description: p.postcondition_description || '',
        code_snippet: buildCodeSnippet(absRepo, file, line),
        id: violationId(repo.name, file, line, rule_id),
      };
    });

    const outPath = path.join(VIOLATIONS_DIR, `${repo.name}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ repo: repo.name, violations }, null, 2) + '\n',
      'utf-8',
    );
    console.log(`  captured ${violations.length} violations -> ${outPath}`);
    summary.repos_scanned++;
    summary.total_violations += violations.length;
  }

  console.log('');
  console.log('--- summary ---');
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  console.log(`Violations captured under: ${VIOLATIONS_DIR}`);
  console.log(`Scan JSON outputs under:  ${SCAN_OUTPUT_DIR}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
