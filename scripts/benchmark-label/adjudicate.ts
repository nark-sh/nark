/**
 * Terminal adjudication CLI.
 *
 * Reads all labels/*.jsonl files under ~/.nark/benchmark-label/. Filters to
 * `disagree` + `escalate` entries. Presents each interactively:
 *   - Prints the code snippet with the callsite highlighted.
 *   - Shows both labeler verdicts (and the Opus verdict if opus-verify ran).
 *   - Waits for a single-character keypress: [T]P / [F]P / [S]kip / [N]ote / [Q]uit.
 *
 * Progress persists to ~/.nark/benchmark-label/labels-final.jsonl after every
 * decision, so quitting and resuming loses no work.
 *
 * Usage: pnpm label:adjudicate
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import type { LabeledViolation } from './types.js';

const __filename = fileURLToPath(import.meta.url);
void __filename;

const STATE_DIR = path.join(os.homedir(), '.nark', 'benchmark-label');
const LABELS_DIR = path.join(STATE_DIR, 'labels');
const FINAL_PATH = path.join(STATE_DIR, 'labels-final.jsonl');

// ---------------------------------------------------------------------------
// Load labels
// ---------------------------------------------------------------------------

function loadAllLabels(): LabeledViolation[] {
  if (!fs.existsSync(LABELS_DIR)) {
    console.error(`No labels directory at ${LABELS_DIR}. Run 'pnpm label:run' first.`);
    process.exit(1);
  }
  const out: LabeledViolation[] = [];
  const files = fs.readdirSync(LABELS_DIR).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(LABELS_DIR, f), 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LabeledViolation);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

function loadAlreadyAdjudicated(): Set<string> {
  const set = new Set<string>();
  if (!fs.existsSync(FINAL_PATH)) return set;
  const text = fs.readFileSync(FINAL_PATH, 'utf-8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LabeledViolation;
      set.add(entry.violation.id);
    } catch {
      /* ignore */
    }
  }
  return set;
}

function appendFinal(entry: LabeledViolation): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(FINAL_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function renderEntry(entry: LabeledViolation, idx: number, total: number): void {
  const v = entry.violation;
  const bar = '─'.repeat(60);
  console.log('');
  console.log(bar);
  console.log(
    `Adjudication ${idx + 1} of ${total} · repo: ${v.repo} · file: ${v.file}:${v.line}`,
  );
  console.log('');
  console.log(`Package: ${v.package} · Rule: ${v.rule_id}`);
  console.log(`Postcondition (${v.postcondition_id}):`);
  console.log(`  "${v.postcondition_description}"`);
  console.log('');
  console.log('Code:');
  // Snippet is already line-prefixed by scan-repos.ts
  console.log(indent(v.code_snippet, '  '));
  console.log('');
  for (const l of entry.labelers) {
    const tempPart =
      l.labeler_id === 'A' ? 'sonnet, T=0.2' : l.labeler_id === 'B' ? 'sonnet, T=0.4' : 'opus, T=0.2';
    console.log(
      `Labeler ${l.labeler_id} (${tempPart}): ${l.verdict}  (confidence ${l.confidence.toFixed(2)})`,
    );
    console.log(indent(`"${l.reasoning}"`, '  '));
  }
  console.log('');
  console.log(`Agreement classification: ${entry.agreement}`);
  console.log('');
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

type Decision = 'T' | 'F' | 'S' | 'N' | 'Q';

async function askDecision(rl: readline.Interface): Promise<{ decision: Decision; note?: string }> {
  return new Promise((resolve) => {
    rl.question('Your call [T]P / [F]P / [S]kip / [N]ote and skip / [Q]uit and save: ', (input) => {
      const first = (input.trim().charAt(0) || 'S').toUpperCase();
      const validated: Decision =
        first === 'T' || first === 'F' || first === 'S' || first === 'N' || first === 'Q'
          ? (first as Decision)
          : 'S';
      if (validated === 'N') {
        rl.question('Note (single line): ', (note) => {
          resolve({ decision: 'N', note });
        });
      } else {
        resolve({ decision: validated });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const all = loadAllLabels();
  const needs = all.filter(
    (e) => e.agreement === 'disagree' || e.agreement === 'escalate',
  );
  const done = loadAlreadyAdjudicated();
  const queue = needs.filter((e) => !done.has(e.violation.id));

  console.log(`Loaded ${all.length} labeled violations`);
  console.log(`  needs adjudication: ${needs.length}`);
  console.log(`  already adjudicated: ${done.size}`);
  console.log(`  in this session: ${queue.length}`);

  if (queue.length === 0) {
    console.log('');
    console.log('Nothing to adjudicate. All disagreements / escalations resolved.');
    console.log(`Next: pnpm label:upload  (requires NARK_ADMIN_TOKEN)`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let adjudicated = 0;
  let quit = false;

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    renderEntry(entry, i, queue.length);
    const { decision, note } = await askDecision(rl);
    if (decision === 'Q') {
      quit = true;
      break;
    }
    const resolved: LabeledViolation = {
      ...entry,
      user_decision:
        decision === 'T'
          ? 'TP'
          : decision === 'F'
            ? 'FP'
            : 'skip',
      user_note: note,
    };
    appendFinal(resolved);
    adjudicated++;
  }
  rl.close();

  console.log('');
  console.log('--- session summary ---');
  console.log(`adjudicated this session: ${adjudicated}`);
  console.log(`remaining: ${queue.length - adjudicated}`);
  console.log(`final labels file: ${FINAL_PATH}`);
  if (quit) console.log('(quit early — resume later with the same command)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
