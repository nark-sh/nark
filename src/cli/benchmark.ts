/**
 * CLI Command: benchmark
 *
 * Ships accuracy-benchmark artifacts to the SaaS accuracy dashboard.
 *
 *   nark benchmark upload --source=<mutation|gold> <path-to-json>
 *
 * Two source types, both defined in work-packages/accuracy-roadmap/:
 *   - mutation: JSON output from scripts/mutation-harness/runner.ts (0004)
 *   - gold:     JSON output from a hand-labeled gold benchmark (0003)
 *
 * The payload is transformed into the shape defined by 0006 §6, POSTed to
 * `<NARK_ADMIN_API_URL>/api/admin/accuracy-runs` (default
 * https://app.nark.sh) with `X-Nark-Admin-Token` header authentication.
 *
 * The upload is a straight HTTP POST — no telemetry rules, no rate limiting.
 * Env vars:
 *   NARK_ADMIN_TOKEN   — required, admin bearer token
 *   NARK_ADMIN_API_URL — optional, defaults to https://app.nark.sh
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Payload shapes (mirrors work-packages/accuracy-roadmap/0006-accuracy-dashboard-spec.md §6)
// ---------------------------------------------------------------------------

interface PerRuleMetric {
  package: string;
  rule_id: string;
  precision: number | null;
  recall: number | null;
  sample_size: number;
  tp: number;
  fp: number;
  fn: number;
}

interface IngestPayload {
  source: 'mutation' | 'gold' | 'adversarial';
  scanner_version: string;
  corpus_version: string;
  nark_commit_sha: string;
  corpus_commit_sha: string;
  ran_at: string;
  benchmark_version: string | null;
  aggregate: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    sample_size: number;
    tp: number;
    fp: number;
    fn: number;
  };
  per_rule: PerRuleMetric[];
  raw_artifact_url: string | null;
}

// ---------------------------------------------------------------------------
// Transform: mutation-run JSON → ingest payload
// ---------------------------------------------------------------------------

interface MutationRunReport {
  run_id: string;
  ran_at: string;
  scanner_version: string;
  corpus_version: string;
  nark_commit_sha?: string;
  corpus_commit_sha?: string;
  sample_rate: number;
  totals: {
    pairs: number;
    pass: number;
    fail_recall: number;
    fail_precision: number;
    fail_noise: number;
    skip: number;
  };
  aggregates: {
    per_operator: Record<
      string,
      {
        pass: number;
        fail_recall: number;
        fail_precision: number;
        fail_noise: number;
        skip: number;
        coverage: number;
      }
    >;
  };
  results: Array<{
    seed_path: string;
    package_name: string;
    operator: string;
    outcome: string;
    violations_before: Array<{ package: string; rule: string }>;
    violations_after: Array<{ package: string; rule: string }>;
  }>;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function transformMutation(report: MutationRunReport): IngestPayload {
  // Aggregate mapping from spec §4:
  //   pass                 → correct classification (TP for expected+violation, TN for expected-unchanged)
  //   fail-recall          → the scanner MISSED a violation the mutation implied → FN
  //   fail-precision       → the scanner still fired when it shouldn't have → FP
  //   fail-noise           → the scanner fired on unrelated line during a neutral mutation → FP
  //   skip                 → excluded from denominators
  //
  // The framing chosen: TP = pass, FP = fail-precision + fail-noise, FN = fail-recall.
  // This matches how the dashboard interprets precision/recall (0006 §5 table).
  const t = report.totals;
  const tp = t.pass;
  const fp = t.fail_precision + t.fail_noise;
  const fn = t.fail_recall;

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  // Per-rule aggregation: group results by (package_name, rule) from violation set.
  // For the mutation harness we don't have per-postcondition breakdown at the runner
  // level (yet), so we synthesize per-operator entries under the "mutation-harness" pseudo-package.
  const perRule: PerRuleMetric[] = [];
  for (const [op, agg] of Object.entries(report.aggregates.per_operator)) {
    const rTp = agg.pass;
    const rFp = agg.fail_precision + agg.fail_noise;
    const rFn = agg.fail_recall;
    const sample = rTp + rFp + rFn;
    if (sample === 0) continue;
    perRule.push({
      package: 'mutation-harness',
      rule_id: op,
      precision: ratio(rTp, rTp + rFp),
      recall: ratio(rTp, rTp + rFn),
      sample_size: sample,
      tp: rTp,
      fp: rFp,
      fn: rFn,
    });
  }

  return {
    source: 'mutation',
    scanner_version: report.scanner_version,
    corpus_version: report.corpus_version,
    nark_commit_sha: report.nark_commit_sha ?? '',
    corpus_commit_sha: report.corpus_commit_sha ?? '',
    ran_at: report.ran_at,
    benchmark_version: null,
    aggregate: {
      precision,
      recall,
      f1,
      sample_size: tp + fp + fn,
      tp,
      fp,
      fn,
    },
    per_rule: perRule,
    raw_artifact_url: null,
  };
}

// ---------------------------------------------------------------------------
// Transform: gold-benchmark JSON → ingest payload
// ---------------------------------------------------------------------------

interface GoldRuleMetric {
  package: string;
  rule_id: string;
  tp: number;
  fp: number;
  fn: number;
  deferred?: number;
}

interface GoldRepoResult {
  repo: string;
  rule_metrics: GoldRuleMetric[];
  tp_count: number;
  fp_count: number;
  fn_count: number;
  deferred_count?: number;
}

interface GoldBenchmarkReport {
  run_id: string;
  ran_at: string;
  scanner_version: string;
  corpus_version: string;
  nark_commit_sha?: string;
  corpus_commit_sha?: string;
  benchmark_version?: string;
  repo_results: GoldRepoResult[];
}

function transformGold(report: GoldBenchmarkReport): IngestPayload {
  // Aggregate TP/FP/FN across all repos.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const ruleMap = new Map<string, { tp: number; fp: number; fn: number; pkg: string; rule: string }>();

  for (const repo of report.repo_results) {
    tp += repo.tp_count;
    fp += repo.fp_count;
    fn += repo.fn_count;
    for (const rule of repo.rule_metrics) {
      const key = `${rule.package}::${rule.rule_id}`;
      const cur = ruleMap.get(key) ?? { tp: 0, fp: 0, fn: 0, pkg: rule.package, rule: rule.rule_id };
      cur.tp += rule.tp;
      cur.fp += rule.fp;
      cur.fn += rule.fn;
      ruleMap.set(key, cur);
    }
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  const perRule: PerRuleMetric[] = [];
  for (const { tp: rTp, fp: rFp, fn: rFn, pkg, rule } of ruleMap.values()) {
    const sample = rTp + rFp + rFn;
    if (sample === 0) continue;
    perRule.push({
      package: pkg,
      rule_id: rule,
      precision: ratio(rTp, rTp + rFp),
      recall: ratio(rTp, rTp + rFn),
      sample_size: sample,
      tp: rTp,
      fp: rFp,
      fn: rFn,
    });
  }

  return {
    source: 'gold',
    scanner_version: report.scanner_version,
    corpus_version: report.corpus_version,
    nark_commit_sha: report.nark_commit_sha ?? '',
    corpus_commit_sha: report.corpus_commit_sha ?? '',
    ran_at: report.ran_at,
    benchmark_version: report.benchmark_version ?? null,
    aggregate: {
      precision,
      recall,
      f1,
      sample_size: tp + fp + fn,
      tp,
      fp,
      fn,
    },
    per_rule: perRule,
    raw_artifact_url: null,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

interface UploadResult {
  status: number;
  body: string;
  runId?: string;
}

async function postIngest(
  apiBase: string,
  token: string,
  payload: IngestPayload,
): Promise<UploadResult> {
  const url = `${apiBase.replace(/\/$/, '')}/api/admin/accuracy-runs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Nark-Admin-Token': token,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  let runId: string | undefined;
  try {
    const parsed = JSON.parse(body);
    runId = parsed?.data?.run_id;
  } catch {
    // Non-JSON body — leave runId undefined.
  }
  return { status: res.status, body, runId };
}

// ---------------------------------------------------------------------------
// CLI subcommand
// ---------------------------------------------------------------------------

export function createBenchmarkCommand(): Command {
  const cmd = new Command('benchmark').description(
    'Accuracy-benchmark artifact management (per work-packages/accuracy-roadmap/)',
  );

  cmd
    .command('upload')
    .description(
      'Upload an accuracy-run JSON to the SaaS accuracy dashboard (POST /api/admin/accuracy-runs).',
    )
    .argument('<path>', 'Path to the accuracy-run JSON file to upload')
    .option(
      '--source <type>',
      'Artifact source: "mutation" (from scripts/mutation-harness/runner.ts) or "gold" (from hand-labeled gold benchmark)',
      'mutation',
    )
    .action(async (jsonPath: string, options: { source: string }) => {
      const source = options.source;
      if (source !== 'mutation' && source !== 'gold') {
        console.error(
          chalk.red(
            `Error: --source must be "mutation" or "gold", got "${source}"`,
          ),
        );
        process.exit(1);
      }

      const resolved = path.resolve(jsonPath);
      if (!fs.existsSync(resolved)) {
        console.error(chalk.red(`Error: file not found: ${resolved}`));
        process.exit(1);
      }

      const token = process.env.NARK_ADMIN_TOKEN;
      if (!token) {
        console.error(
          chalk.red(
            'Error: NARK_ADMIN_TOKEN environment variable is not set. Set it to the admin bearer token before invoking `nark benchmark upload`.',
          ),
        );
        process.exit(1);
      }
      const apiBase = process.env.NARK_ADMIN_API_URL ?? 'https://app.nark.sh';

      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      } catch (err) {
        console.error(
          chalk.red(
            `Error parsing JSON at ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }

      let payload: IngestPayload;
      try {
        if (source === 'mutation') {
          payload = transformMutation(raw as MutationRunReport);
        } else {
          payload = transformGold(raw as GoldBenchmarkReport);
        }
      } catch (err) {
        console.error(
          chalk.red(
            `Error transforming ${source} report: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }

      console.log(
        chalk.gray(
          `Uploading ${source} run to ${apiBase} (scanner ${payload.scanner_version}, corpus ${payload.corpus_version}, sample_size=${payload.aggregate.sample_size})…`,
        ),
      );

      let result: UploadResult;
      try {
        result = await postIngest(apiBase, token, payload);
      } catch (err) {
        console.error(
          chalk.red(
            `Network error uploading run: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }

      if (result.status >= 200 && result.status < 300) {
        console.log(
          chalk.green(
            `Uploaded successfully${result.runId ? ` (run id: ${result.runId})` : ''}.`,
          ),
        );
        process.exit(0);
      } else {
        console.error(
          chalk.red(`Upload failed with status ${result.status}:`),
        );
        console.error(result.body);
        process.exit(1);
      }
    });

  return cmd;
}
