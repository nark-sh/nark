/**
 * Repo shortlist ranker.
 *
 * Reads the 60-candidate list from
 *   work-packages/accuracy-roadmap/0003-gold-benchmark-candidates.md
 * (or, if it exists, the pre-parsed JSON export at
 *   work-packages/accuracy-roadmap/0003-candidates.json)
 * and scores each candidate on 5 weighted criteria. Outputs 50 selected + 10
 * reserve to work-packages/accuracy-roadmap/shortlist.json.
 *
 * Runs offline. No API calls. No secrets required. <5 seconds.
 *
 * Usage: pnpm label:rank
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  CoverageReport,
  Framework,
  RepoCandidate,
  Shortlist,
  SizeBucket,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // nark-dev/nark
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..', '..'); // behavioral-contracts

const CANDIDATES_MD = path.join(
  WORKSPACE_ROOT,
  'work-packages',
  'accuracy-roadmap',
  '0003-gold-benchmark-candidates.md',
);
const CANDIDATES_JSON = path.join(
  WORKSPACE_ROOT,
  'work-packages',
  'accuracy-roadmap',
  '0003-candidates.json',
);
const OUTPUT_PATH = path.join(
  WORKSPACE_ROOT,
  'work-packages',
  'accuracy-roadmap',
  'shortlist.json',
);
const TEST_REPOS_ROOT = path.join(WORKSPACE_ROOT, 'test-repos');

// ---------------------------------------------------------------------------
// Weights (documented; tune if the coverage report shows gaps).
// ---------------------------------------------------------------------------
const WEIGHTS = {
  package_coverage: 0.30, // Does the repo exercise contracted packages?
  prior_harvester: 0.20, // Partial labels already exist?
  framework_diversity: 0.20, // Does this repo help spread framework mix?
  size_mix: 0.15, // Enforce 30/30/30 across shortlist.
  violation_density: 0.15, // >0 but not >500 is best.
};

const SIZE_BUCKET_TARGETS: Record<SizeBucket, number> = {
  S: 15, // ~30% of 50
  M: 15,
  L: 15,
  // 5 slack slots — allocated by score after budgets fill
};

// ---------------------------------------------------------------------------
// Markdown table parser (with JSON fallback)
// ---------------------------------------------------------------------------

interface RawRow {
  raw_number: string;
  repo_path: string;
  framework: string;
  size: string;
  packages: string;
  harvester: string;
  violations: string;
  rationale: string;
}

function parseCandidatesMd(md: string): RawRow[] {
  const lines = md.split('\n');
  const rows: RawRow[] = [];
  let inSection3 = false;

  for (const line of lines) {
    if (line.startsWith('## Section 3')) {
      inSection3 = true;
      continue;
    }
    if (inSection3 && line.startsWith('## Section 4')) break;
    if (!inSection3) continue;
    if (!line.startsWith('|')) continue;

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 8) continue;
    if (cells[0] === '#') continue; // header
    if (/^-+$/.test(cells[0])) continue; // separator
    if (!/^\d+$/.test(cells[0])) continue; // skip stray rows

    rows.push({
      raw_number: cells[0],
      repo_path: cells[1],
      framework: cells[2],
      size: cells[3],
      packages: cells[4],
      harvester: cells[5],
      violations: cells[6],
      rationale: cells[7],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeFramework(raw: string): Framework {
  const lc = raw.toLowerCase();
  if (lc.includes('nextjs')) return 'nextjs';
  if (lc.includes('nest')) return 'nest';
  if (lc.includes('express')) return 'express';
  if (lc.includes('monorepo')) return 'monorepo';
  if (lc.includes('library')) return 'library';
  if (lc.includes('vue')) return 'vue';
  if (lc.includes('tauri')) return 'tauri';
  if (lc.includes('node-script') || lc.includes('node')) return 'node-script';
  return 'other';
}

function normalizeSize(raw: string): SizeBucket {
  if (raw.startsWith('S')) return 'S';
  if (raw.startsWith('M')) return 'M';
  if (raw.startsWith('L')) return 'L';
  // Default: treat unknown as M
  return 'M';
}

function normalizeHarvester(raw: string): boolean {
  return raw.toLowerCase().startsWith('yes');
}

function extractPackages(raw: string): string[] {
  // "stripe, next, next-auth, @prisma/client, zod, react-hook-form"
  // We keep entries verbatim; downstream matches against corpus profiles.
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith('(workspace') && !p.startsWith('-'));
}

function extractViolationCount(raw: string): number {
  // "901 (wave 1)" -> 901; "not scanned" -> 0; "mid (luxon audit)" -> 15 rough est.
  const m = raw.match(/^(\d+)/);
  if (m) return parseInt(m[1], 10);
  if (raw.toLowerCase().includes('not scanned')) return 0;
  if (raw.toLowerCase().includes('mid')) return 25;
  return 0;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scorePackageCoverage(pkgs: string[]): number {
  // Cap at 12 packages exercised (beyond that we don't gain much labeling signal).
  const capped = Math.min(pkgs.length, 12);
  return (capped / 12) * 100;
}

function scorePriorHarvester(has: boolean): number {
  return has ? 100 : 0;
}

function scoreViolationDensity(count: number): number {
  // 0 = we DO want a couple zero-violation calibration repos; give small credit.
  if (count === 0) return 30;
  // Sweet spot 20-200
  if (count < 20) return 40 + (count / 20) * 30; // 40-70
  if (count <= 200) return 100; // sweet spot
  if (count <= 500) return 70;
  return 40; // >500 is a labeling burden
}

/**
 * Two-pass scoring: first compute a base score from criteria that don't depend
 * on the shortlist composition, then in a second pass award framework
 * diversity + size-mix bonuses relative to what's already been selected.
 */
export function rankCandidates(candidates: RepoCandidate[]): Shortlist {
  // ---- Base scores
  for (const c of candidates) {
    const pkg = scorePackageCoverage(c.packages_exercised);
    const harv = scorePriorHarvester(c.prior_harvester_touch);
    const dens = scoreViolationDensity(c.estimated_violation_count);
    // Framework diversity + size mix are applied in the greedy pass below.
    c.score =
      WEIGHTS.package_coverage * pkg +
      WEIGHTS.prior_harvester * harv +
      WEIGHTS.violation_density * dens;
  }

  // ---- Greedy pass with diversity budgets
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected: RepoCandidate[] = [];
  const reserve: RepoCandidate[] = [];
  const frameworkCount: Record<Framework, number> = {
    nextjs: 0,
    nest: 0,
    express: 0,
    monorepo: 0,
    library: 0,
    'node-script': 0,
    vue: 0,
    tauri: 0,
    other: 0,
  };
  const sizeCount: Record<SizeBucket, number> = { S: 0, M: 0, L: 0 };
  const TARGET_SELECTED = 50;
  const TARGET_RESERVE = 10;

  for (const c of sorted) {
    if (selected.length >= TARGET_SELECTED) {
      if (reserve.length < TARGET_RESERVE) {
        c.reserve = true;
        reserve.push(c);
      }
      continue;
    }

    // Diversity bonus: framework not yet represented adds up to 20 points
    const fwSeen = frameworkCount[c.framework];
    const fwBonus = fwSeen === 0 ? 20 : fwSeen < 3 ? 10 : fwSeen < 6 ? 5 : 0;

    // Size budget: penalize if bucket is over its target
    const sizeSeen = sizeCount[c.size_bucket];
    const sizeTarget = SIZE_BUCKET_TARGETS[c.size_bucket];
    const sizePenalty = sizeSeen >= sizeTarget ? -15 : 0;

    c.score = c.score + WEIGHTS.framework_diversity * fwBonus + WEIGHTS.size_mix * sizePenalty;

    selected.push(c);
    frameworkCount[c.framework]++;
    sizeCount[c.size_bucket]++;
  }

  // Final re-sort of selected by adjusted score for readability
  selected.sort((a, b) => b.score - a.score);

  // ---- Coverage report
  const coverage = computeCoverage(selected);

  return {
    repos: [...selected, ...reserve],
    criteria_used: [
      'package_coverage (30%)',
      'prior_harvester_touch (20%)',
      'framework_diversity_bonus (20%)',
      'size_mix_budget (15%)',
      'violation_density (15%)',
    ],
    weights: WEIGHTS,
    coverage_report: coverage,
    generated_at: new Date().toISOString(),
  };
}

function computeCoverage(selected: RepoCandidate[]): CoverageReport {
  const packageCounts = new Map<string, number>();
  for (const r of selected) {
    for (const p of r.packages_exercised) {
      packageCounts.set(p, (packageCounts.get(p) || 0) + 1);
    }
  }
  const zero: string[] = [];
  const thin: string[] = [];
  const ok: string[] = [];
  // We reference the top-30 packages from 0003; hard-coded list keeps the
  // ranker offline-independent of a live corpus walk.
  const TOP_PACKAGES = [
    'next',
    '@prisma/client',
    'axios',
    '@aws-sdk/client-s3',
    'stripe',
    'next-auth',
    'zod',
    '@tanstack/react-query',
    '@upstash/redis',
    'drizzle-orm',
    'ai',
    '@sentry/nextjs',
    '@clerk/nextjs',
    'jsonwebtoken',
    'date-fns',
    '@supabase/supabase-js',
    '@notionhq/client',
    'pino',
    'express',
    'pg',
    'resend',
    'posthog-node',
    'mongoose',
    '@octokit/rest',
    'winston',
    '@google/generative-ai',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    'inngest',
    'replicate',
    'twilio',
    'bullmq',
    'discord.js',
    'socket.io',
    '@sendgrid/mail',
    'algoliasearch',
  ];
  for (const p of TOP_PACKAGES) {
    const c = packageCounts.get(p) || 0;
    if (c === 0) zero.push(p);
    else if (c === 1) thin.push(p);
    else ok.push(p);
  }

  const frameworkMix: Record<Framework, number> = {
    nextjs: 0,
    nest: 0,
    express: 0,
    monorepo: 0,
    library: 0,
    'node-script': 0,
    vue: 0,
    tauri: 0,
    other: 0,
  };
  const sizeMix: Record<SizeBucket, number> = { S: 0, M: 0, L: 0 };
  for (const r of selected) {
    frameworkMix[r.framework]++;
    sizeMix[r.size_bucket]++;
  }

  return {
    packages_zero_coverage: zero,
    packages_thin_coverage: thin,
    packages_ok_coverage: ok,
    framework_mix: frameworkMix,
    size_mix: sizeMix,
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function loadCandidates(): RepoCandidate[] {
  // Prefer JSON if present
  if (fs.existsSync(CANDIDATES_JSON)) {
    const raw = JSON.parse(fs.readFileSync(CANDIDATES_JSON, 'utf-8'));
    if (Array.isArray(raw)) return raw as RepoCandidate[];
    if (Array.isArray(raw.candidates)) return raw.candidates as RepoCandidate[];
  }

  if (!fs.existsSync(CANDIDATES_MD)) {
    throw new Error(`Candidates source not found: ${CANDIDATES_MD}`);
  }
  const md = fs.readFileSync(CANDIDATES_MD, 'utf-8');
  const rows = parseCandidatesMd(md);
  return rows
    .filter((r) => r.repo_path.startsWith('test-repos/'))
    .map((r) => {
      const name = r.repo_path.replace(/^test-repos\//, '').trim();
      const absPath = path.join(TEST_REPOS_ROOT, name);
      return {
        name,
        path: absPath,
        framework: normalizeFramework(r.framework),
        size_bucket: normalizeSize(r.size),
        packages_exercised: extractPackages(r.packages),
        prior_harvester_touch: normalizeHarvester(r.harvester),
        estimated_violation_count: extractViolationCount(r.violations),
        rationale: r.rationale,
        score: 0,
      };
    });
}

function writeShortlist(shortlist: Shortlist): void {
  // Preserve character encoding per .claude/rules/json-serialization.md
  // (default JSON.stringify does not escape non-ASCII).
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(shortlist, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const candidates = loadCandidates();
  console.log(`Loaded ${candidates.length} candidates from source`);
  if (candidates.length === 0) {
    console.error('ERROR: no candidates parsed. Check the markdown table format.');
    process.exit(1);
  }

  const shortlist = rankCandidates(candidates);
  writeShortlist(shortlist);

  const selected = shortlist.repos.filter((r) => !r.reserve);
  const reserve = shortlist.repos.filter((r) => r.reserve);

  console.log('---');
  console.log(`Selected: ${selected.length} repos`);
  console.log(`Reserve: ${reserve.length} repos`);
  console.log('Framework mix (top-50):');
  for (const [fw, ct] of Object.entries(shortlist.coverage_report.framework_mix)) {
    if (ct > 0) console.log(`  ${fw}: ${ct}`);
  }
  console.log('Size mix (top-50):');
  for (const [sz, ct] of Object.entries(shortlist.coverage_report.size_mix)) {
    console.log(`  ${sz}: ${ct}`);
  }
  console.log('');
  const gaps = shortlist.coverage_report.packages_zero_coverage;
  if (gaps.length > 0) {
    console.log(`Zero-coverage packages (${gaps.length}): ${gaps.join(', ')}`);
    console.log('  -> consider sourcing repos for these before running the full label pass');
  }
  const thin = shortlist.coverage_report.packages_thin_coverage;
  if (thin.length > 0) {
    console.log(`Thin-coverage packages (${thin.length}, single repo only): ${thin.join(', ')}`);
  }
  console.log('---');
  console.log(`Shortlist written to: ${OUTPUT_PATH}`);
}

// ES module main-guard
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
