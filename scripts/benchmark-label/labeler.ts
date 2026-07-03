/**
 * Double-blind labeler.
 *
 * For every violation captured by scan-repos.ts, invoke two independent
 * Claude API calls with the SAME prompt but distinct sampling parameters:
 *   Labeler A: sonnet 4.6, T=0.2
 *   Labeler B: sonnet 4.6, T=0.4
 * Aggregate:
 *   both TP -> agreed_TP
 *   both FP -> agreed_FP
 *   both undecidable -> escalate
 *   split TP/FP -> disagree
 *   any undecidable mixed with decided -> escalate
 * Optional --opus-verify runs a 3rd call (Opus 4.7, T=0.2) on disagreements
 * to break the tie.
 *
 * Crash-safe: writes JSONL incrementally to
 *   ~/.nark/benchmark-label/labels/<repo>.jsonl
 * A re-run resumes by skipping violation IDs already present in that file.
 *
 * Prompt caching:
 *   The system prompt (large, static) is sent as a cache_control block on
 *   every call. Anthropic reuses the prefix across calls made within the
 *   cache TTL (~5 min), so the effective input cost after the first call
 *   drops by ~90% for the cached portion.
 *
 * Usage:
 *   pnpm label:run [--opus-verify] [--repo <name>] [--concurrency N] [--dry-run]
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  LabeledViolation,
  LabelerId,
  LabelerVerdict,
  RunStats,
  Verdict,
  Violation,
} from './types.js';
import { LABELER_PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompts.js';

// Dynamic import so scripts that don't need the SDK (rank, scan, adjudicate)
// don't fail if @anthropic-ai/sdk isn't installed.
type AnthropicClient = {
  messages: {
    create: (req: unknown) => Promise<{
      content: Array<{ type: string; text?: string }>;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    }>;
  };
};

const __filename = fileURLToPath(import.meta.url);
// __dirname unused: state paths anchor to os.homedir(). Kept above line for
// parity with other scripts in this folder in case future features need it.
void __filename;

const STATE_DIR = path.join(os.homedir(), '.nark', 'benchmark-label');
const VIOLATIONS_DIR = path.join(STATE_DIR, 'violations');
const LABELS_DIR = path.join(STATE_DIR, 'labels');

// Model IDs. These are the canonical Claude 4.6 / 4.7 model IDs.
const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_OPUS = 'claude-opus-4-7';

// Rough per-model USD pricing per 1M tokens (input / output). Update if pricing
// changes. Cache-read tokens are billed at ~10% of the input rate. Cache-
// creation tokens are billed at ~125% of the input rate for the first write.
const PRICING = {
  [MODEL_SONNET]: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  [MODEL_OPUS]: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
};

// Default concurrency. Sonnet has generous RPM/TPM; 10 in flight is safe.
const DEFAULT_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  opusVerify: boolean;
  repoFilter: string | null;
  concurrency: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    opusVerify: false,
    repoFilter: null,
    concurrency: DEFAULT_CONCURRENCY,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--opus-verify') args.opusVerify = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--repo') args.repoFilter = argv[++i];
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Resume: read already-labeled IDs from JSONL files
// ---------------------------------------------------------------------------

function loadExistingLabels(repo: string): Map<string, LabeledViolation> {
  const p = path.join(LABELS_DIR, `${repo}.jsonl`);
  const map = new Map<string, LabeledViolation>();
  if (!fs.existsSync(p)) return map;
  const text = fs.readFileSync(p, 'utf-8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LabeledViolation;
      map.set(entry.violation.id, entry);
    } catch {
      // ignore malformed line — will be re-labeled
    }
  }
  return map;
}

function appendLabel(repo: string, entry: LabeledViolation): void {
  fs.mkdirSync(LABELS_DIR, { recursive: true });
  const p = path.join(LABELS_DIR, `${repo}.jsonl`);
  fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Anthropic client construction (real or dry-run)
// ---------------------------------------------------------------------------

async function makeClient(dryRun: boolean): Promise<AnthropicClient> {
  if (dryRun) {
    return {
      messages: {
        create: async (req: unknown) => {
          // Deterministic pseudo-verdict from the prompt hash so dry-runs are
          // reproducible without an API key.
          const r = req as {
            system: Array<{ text: string }>;
            messages: Array<{ content: Array<{ text: string }> }>;
            temperature?: number;
          };
          const userText = r.messages[0].content[0].text;
          const seed = simpleHash(userText + String(r.temperature ?? 0));
          const pick = seed % 10;
          let verdict: Verdict;
          if (pick < 5) verdict = 'TP';
          else if (pick < 9) verdict = 'FP';
          else verdict = 'undecidable';
          const body = {
            verdict,
            reasoning: `[dry-run] deterministic verdict based on prompt hash (seed=${seed})`,
            confidence: 0.7,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(body) }],
            usage: {
              input_tokens: 500,
              output_tokens: 60,
              cache_read_input_tokens: 450,
              cache_creation_input_tokens: 0,
            },
          };
        },
      },
    };
  }
  // Real client
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not set. Set it in your shell or pass --dry-run to test the pipeline.',
    );
  }
  // Dynamic import so a missing SDK doesn't crash the module-level import
  // (which would also break rank/scan/adjudicate). String-indirect so
  // TypeScript doesn't require @anthropic-ai/sdk types at build time; the
  // SDK is resolved at runtime from the installed devDep.
  const sdkName = '@anthropic-ai/sdk';
  const mod = (await import(sdkName)) as unknown as {
    default: new (opts: { apiKey: string }) => AnthropicClient;
  };
  return new mod.default({ apiKey });
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// Single labeler call
// ---------------------------------------------------------------------------

async function callLabeler(
  client: AnthropicClient,
  violation: Violation,
  labelerId: LabelerId,
  model: string,
  temperature: number,
): Promise<LabelerVerdict> {
  const userPrompt = buildUserPrompt({
    package: violation.package,
    postcondition_id: violation.postcondition_id,
    postcondition_description: violation.postcondition_description,
    file: violation.file,
    line: violation.line,
    code_snippet: violation.code_snippet,
  });

  const started = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: 400,
    temperature,
    // System prompt is cache-eligible. It's static across ~all calls, so
    // after the first call warms the cache, subsequent calls hit ~all
    // system-prompt tokens as cache_read.
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: userPrompt }],
      },
    ],
  });
  const latency = Date.now() - started;

  const textBlock = response.content.find((c) => c.type === 'text');
  const raw = textBlock?.text ?? '';
  const { verdict, reasoning, confidence } = parseVerdictJson(raw);

  return {
    labeler_id: labelerId,
    verdict,
    reasoning,
    confidence,
    model_used: model,
    latency_ms: latency,
    prompt_version: LABELER_PROMPT_VERSION,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

function parseVerdictJson(raw: string): {
  verdict: Verdict;
  reasoning: string;
  confidence: number;
} {
  // Strip common wrappers (markdown fence, leading text)
  let text = raw.trim();
  const fenceStart = text.indexOf('```');
  if (fenceStart >= 0) {
    const rest = text.slice(fenceStart + 3);
    const fenceEnd = rest.indexOf('```');
    if (fenceEnd >= 0) {
      text = rest.slice(0, fenceEnd).replace(/^json\s*/i, '').trim();
    }
  }
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd >= 0) {
    text = text.slice(braceStart, braceEnd + 1);
  }
  try {
    const parsed = JSON.parse(text);
    const v = parsed.verdict;
    if (v !== 'TP' && v !== 'FP' && v !== 'undecidable') {
      return { verdict: 'undecidable', reasoning: `bad verdict: ${v}`, confidence: 0 };
    }
    return {
      verdict: v as Verdict,
      reasoning: String(parsed.reasoning || ''),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch {
    return {
      verdict: 'undecidable',
      reasoning: `unparseable response: ${raw.slice(0, 120)}`,
      confidence: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(a: LabelerVerdict, b: LabelerVerdict): LabeledViolation['agreement'] {
  if (a.verdict === b.verdict) {
    if (a.verdict === 'TP') return 'agreed_TP';
    if (a.verdict === 'FP') return 'agreed_FP';
    return 'escalate'; // both undecidable
  }
  if (a.verdict === 'undecidable' || b.verdict === 'undecidable') return 'escalate';
  return 'disagree';
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function accumulateStats(stats: RunStats, verdicts: LabelerVerdict[]): void {
  for (const v of verdicts) {
    const p = PRICING[v.model_used as keyof typeof PRICING];
    if (!p) continue;
    stats.total_input_tokens += v.usage.input_tokens;
    stats.total_output_tokens += v.usage.output_tokens;
    stats.total_cache_read_tokens += v.usage.cache_read_input_tokens;
    stats.total_cache_created_tokens += v.usage.cache_creation_input_tokens;

    stats.estimated_usd +=
      (v.usage.input_tokens / 1_000_000) * p.input +
      (v.usage.output_tokens / 1_000_000) * p.output +
      (v.usage.cache_read_input_tokens / 1_000_000) * p.cache_read +
      (v.usage.cache_creation_input_tokens / 1_000_000) * p.cache_write;
  }
}

// ---------------------------------------------------------------------------
// Progress display
// ---------------------------------------------------------------------------

function renderProgress(stats: RunStats): void {
  const line = [
    `labeled ${stats.labeled}/${stats.total_violations}`,
    `agreed ${pct(stats.agreed_TP + stats.agreed_FP, stats.labeled)}`,
    `disagreed ${pct(stats.disagreed, stats.labeled)}`,
    `escalated ${pct(stats.escalated, stats.labeled)}`,
    `est cost so far $${stats.estimated_usd.toFixed(2)}`,
  ].join(' · ');
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line}   `);
  } else if (stats.labeled % 25 === 0) {
    console.log(line);
  }
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${((part / total) * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Per-repo processing (concurrent)
// ---------------------------------------------------------------------------

async function processRepo(
  client: AnthropicClient,
  repo: string,
  violations: Violation[],
  args: Args,
  stats: RunStats,
): Promise<void> {
  const existing = loadExistingLabels(repo);
  const todo = violations.filter((v) => !existing.has(v.id));
  console.log(
    `\n[${repo}] ${violations.length} total · ${existing.size} already labeled · ${todo.length} to do`,
  );

  // Fold already-labeled entries into stats before starting
  for (const entry of existing.values()) {
    stats.labeled++;
    if (entry.agreement === 'agreed_TP') stats.agreed_TP++;
    else if (entry.agreement === 'agreed_FP') stats.agreed_FP++;
    else if (entry.agreement === 'disagree') stats.disagreed++;
    else stats.escalated++;
    accumulateStats(stats, entry.labelers);
  }

  const queue = [...todo];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < args.concurrency; i++) {
    workers.push(worker(i, queue, client, repo, args, stats));
  }
  await Promise.all(workers);
}

async function worker(
  _id: number,
  queue: Violation[],
  client: AnthropicClient,
  repo: string,
  args: Args,
  stats: RunStats,
): Promise<void> {
  while (queue.length > 0) {
    const v = queue.shift();
    if (!v) return;
    try {
      const [a, b] = await Promise.all([
        callLabeler(client, v, 'A', MODEL_SONNET, 0.2),
        callLabeler(client, v, 'B', MODEL_SONNET, 0.4),
      ]);
      const verdicts: LabelerVerdict[] = [a, b];
      let agreement = aggregate(a, b);

      if (args.opusVerify && agreement === 'disagree') {
        const c = await callLabeler(client, v, 'C', MODEL_OPUS, 0.2);
        verdicts.push(c);
        // Opus verdict breaks tie: if C matches A or B, we upgrade to agreed_*
        if (c.verdict === 'TP') agreement = 'agreed_TP';
        else if (c.verdict === 'FP') agreement = 'agreed_FP';
        else agreement = 'escalate';
      }

      const entry: LabeledViolation = {
        violation: v,
        labelers: verdicts,
        agreement,
      };
      appendLabel(repo, entry);

      // Stats
      stats.labeled++;
      if (agreement === 'agreed_TP') stats.agreed_TP++;
      else if (agreement === 'agreed_FP') stats.agreed_FP++;
      else if (agreement === 'disagree') stats.disagreed++;
      else stats.escalated++;
      accumulateStats(stats, verdicts);
      renderProgress(stats);
    } catch (e) {
      const err = e as Error;
      console.error(`\n[${repo}] error on ${v.id}: ${err.message}`);
      // Best-effort backoff — real 429 handling is on our TODO if we hit it.
      await new Promise((r) => setTimeout(r, 2000));
      queue.push(v); // retry once at the end
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(VIOLATIONS_DIR)) {
    console.error(
      `No violations directory at ${VIOLATIONS_DIR}. Run 'pnpm label:scan' first.`,
    );
    process.exit(1);
  }

  const files = fs
    .readdirSync(VIOLATIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !args.repoFilter || f === `${args.repoFilter}.json`);
  if (files.length === 0) {
    console.error(`No violation files found in ${VIOLATIONS_DIR}`);
    process.exit(1);
  }

  // Preload violations to compute a global total for the progress display
  const perRepo: Array<{ repo: string; violations: Violation[] }> = [];
  let total = 0;
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(VIOLATIONS_DIR, f), 'utf-8')) as {
      repo: string;
      violations: Violation[];
    };
    perRepo.push(raw);
    total += raw.violations.length;
  }

  console.log(`Labeler engine starting`);
  console.log(`  prompt version: ${LABELER_PROMPT_VERSION}`);
  console.log(`  models: A=${MODEL_SONNET}(T=0.2), B=${MODEL_SONNET}(T=0.4)`);
  if (args.opusVerify) console.log(`  opus verify: C=${MODEL_OPUS}(T=0.2) on disagreements`);
  console.log(`  concurrency: ${args.concurrency}`);
  console.log(`  dry-run: ${args.dryRun}`);
  console.log(`  repos: ${perRepo.length}, total violations: ${total}`);
  console.log('');

  const client = await makeClient(args.dryRun);
  const stats: RunStats = {
    total_violations: total,
    labeled: 0,
    agreed_TP: 0,
    agreed_FP: 0,
    disagreed: 0,
    escalated: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_created_tokens: 0,
    estimated_usd: 0,
  };

  for (const { repo, violations } of perRepo) {
    await processRepo(client, repo, violations, args, stats);
  }

  console.log('\n');
  console.log('--- final stats ---');
  console.log(JSON.stringify(stats, null, 2));
  console.log('');
  console.log(`Labels written to: ${LABELS_DIR}`);
  console.log(`Next: pnpm label:adjudicate`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
