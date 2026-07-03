# Gold Benchmark Labeling Toolchain (Offline)

End-to-end pipeline for producing a hand-adjudicated gold benchmark for nark's
precision / recall dashboard. The whole flow runs offline on your Mac.
The **only** step that needs a token is the final upload — everything before
that produces JSON files on disk that survive across sessions.

**Deferrable design:** you can build the gold labels on your laptop, walk
away for weeks, and upload them whenever you're ready. Nothing in the
labeling flow itself requires SaaS connectivity.

---

## Why this exists (the double-blind protocol)

To defensibly measure nark's precision and recall, the labelers cannot see
what nark decided. Otherwise "precision" collapses to "how often nark
agrees with itself." Structural blindness comes from:

1. Two independent labelers per violation, invoked in parallel API calls
   with distinct sampling parameters (temperature 0.2 and 0.4).
2. Both labelers see the same reasoning-from-first-principles prompt with
   NO reference to a scanner verdict.
3. Agreement is trusted (agreed_TP / agreed_FP become gold labels).
   Disagreement escalates to human adjudication (you).
4. Verification (per-rule precision / recall / F1) is downstream arithmetic
   done in the SaaS dashboard once the labels are uploaded.

Reference: the "Double-Blind Labeling Protocol" panel on the admin
`/admin/accuracy-roadmap` page and
`work-packages/accuracy-roadmap/0003-gold-benchmark-candidates.md`.

---

## The 5-step workflow

```
      offline                                       online (once, at the end)
┌────────────────────────────────────────────────┐  ┌────────────────────────┐
│ 1. rank        2. scan       3. label   4. adj │  │ 5. upload              │
│    │              │              │        │    │  │    │                   │
│    v              v              v        v    │  │    v                   │
│  shortlist.json  violations/  labels/  labels- │  │  POST /api/admin/     │
│                                        final.  │  │  accuracy-runs        │
└────────────────────────────────────────────────┘  └────────────────────────┘
       ~ 5 sec       ~ minutes    ~ hours   ~ hours       ~ seconds

Env needed:  none         none    ANTHROPIC_    none        NARK_ADMIN_
                                  API_KEY                   TOKEN
```

### 1. Rank candidates → `shortlist.json`

Reads the 60-candidate list from
`work-packages/accuracy-roadmap/0003-gold-benchmark-candidates.md` (or, if you
create one, the pre-parsed JSON at `0003-candidates.json`) and scores each
candidate on 5 weighted criteria:

- Package coverage (30%): does the repo exercise contracted packages?
- Prior harvester triage (20%): partial labels already exist?
- Framework diversity (20%): spread across next / express / nest / lib / monorepo
- Size mix (15%): enforce S / M / L distribution
- Violation density (15%): moderate is best — very small skips signal,
  very large blows up labeling cost

Outputs `work-packages/accuracy-roadmap/shortlist.json` with 50 selected +
10 reserve repos, plus a coverage report flagging any contracted packages
that appear in 0 or 1 shortlisted repos.

```bash
pnpm label:rank
```

### 2. Scan → `~/.nark/benchmark-label/violations/<repo>.json`

For each shortlisted repo present under `test-repos/`, runs nark and captures
violations. Skips repos missing on disk or without a `tsconfig.json`. Uses
the multi-corpus arg (pro + public) per `.claude/rules/multi-corpus.md`, and
`NARK_ALLOW_MISSING_DEPS=1` per `.claude/rules/cloud-scan-architecture.md`.

Each violation is enriched with a 40-line code snippet (20 lines above +
callsite + 19 lines below), with the callsite prefixed by `>` for clarity.

```bash
pnpm label:scan
```

### 3. Label (double-blind) → `~/.nark/benchmark-label/labels/<repo>.jsonl`

For every violation, runs two Claude Sonnet 4.6 calls in parallel — one at
T=0.2, one at T=0.4. Both get the same prompt (no scanner verdict included).
Aggregates:

- both TP → `agreed_TP`
- both FP → `agreed_FP`
- split TP/FP → `disagree`
- any undecidable → `escalate`

Writes JSONL incrementally so a crash loses no work. Re-running resumes by
skipping violations already labeled.

Optional `--opus-verify` runs a 3rd call (Opus 4.7, T=0.2) on disagreements
as a tiebreaker.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm label:run                          # default
pnpm label:run --opus-verify            # add opus tiebreaker
pnpm label:run --repo cal.com           # single repo
pnpm label:run --concurrency 5          # tune rate
pnpm label:run --dry-run                # stub API, verify pipeline (no cost)
```

Live progress: `labeled 342 / 1284 · agreed 74% · disagreed 18% · escalated 8% · est cost so far $23.40`

### 4. Adjudicate → `~/.nark/benchmark-label/labels-final.jsonl`

Terminal-based interactive CLI. Filters to `disagree` + `escalate` entries.
For each:

```
────────────────────────────────────────────────────
Adjudication 12 of 47 · repo: cal.com · file: apps/web/lib/foo.ts:42

Package: axios · Rule: axios/get-throws-on-network
Postcondition: "axios.get() rejects on network failure and 4xx/5xx status."

Code:
    40 |  try {
    41 |    logger.info("fetching");
>   42 |    const res = await axios.get(url);
    43 |    return res.data;
    44 |  } catch (e) { throw e; }

Labeler A (sonnet, T=0.2): FP  (confidence 0.85)
  "The await is wrapped in try/catch and errors are rethrown..."

Labeler B (sonnet, T=0.4): TP  (confidence 0.72)
  "The catch merely rethrows without transformation..."

Your call [T]P / [F]P / [S]kip / [N]ote and skip / [Q]uit and save:
```

Writes to `labels-final.jsonl` after every decision. Quit and resume any time.

```bash
pnpm label:adjudicate
```

### 5. Upload → SaaS

Uses the CLI shipped in Wave 2 (`nark benchmark upload --source=gold`). This
is the **only** step that needs `NARK_ADMIN_TOKEN`. Do it whenever you're
ready — the labels sit safely on disk until then.

```bash
export NARK_ADMIN_TOKEN=...
pnpm label:upload -- --file ~/.nark/benchmark-label/labels-final.jsonl
```

The verification arithmetic (per-rule precision / recall / F1) happens
server-side once the labels are ingested; the accuracy dashboard picks them
up automatically.

---

## Resume semantics

Every step is crash-safe.

| Step | State file(s) | Resume behavior |
|---|---|---|
| rank | `shortlist.json` | Re-run overwrites; deterministic |
| scan | `violations/<repo>.json` | Re-scans everything; overwrites |
| label | `labels/<repo>.jsonl` | Skips already-labeled violation IDs |
| adjudicate | `labels-final.jsonl` | Skips already-adjudicated violation IDs |
| upload | server-side dedup | Wave 2 CLI handles idempotency |

If the labeler is killed mid-flight, the JSONL file contains complete lines
for everything already labeled. Re-run `pnpm label:run` to pick up where
you left off.

---

## Cost estimate

Assumes ~1300 violations in the top-50 shortlist (median 25 per repo, weighted
toward the top-5 large monorepos).

**Sonnet-only (default):**
- 2 calls per violation × 1300 violations = 2600 calls
- System prompt: ~500 tokens, cache-eligible (~90% cache hit after first call)
- User prompt + snippet: ~700 tokens per call
- Output: ~80 tokens per call
- Effective cost: ~$0.03 per violation × 1300 = **~$40** (was ~$90 pre-caching)

**With `--opus-verify`:**
- Adds one Opus call per disagreement (~15% of violations = ~200 calls)
- Opus is 5x sonnet: ~$0.15 per Opus call × 200 = ~$30 extra
- Total: **~$70**

Actual costs will vary with your prompt caching hit rate, the exact size of
each snippet, and the disagreement rate. The labeler prints running cost so
you can pause if the burn is higher than expected.

---

## Prompt caching strategy

Anthropic prompt caching reuses the prefix of a request when the same block
is sent within the cache TTL (~5 minutes). Our labeler:

1. Marks the system prompt (~500 tokens, static across ALL calls) with
   `cache_control: { type: 'ephemeral' }`.
2. Keeps the user prompt (per-violation, unique) uncached.

First call to any given model warms the cache. Every subsequent call within
5 minutes reads the system-prompt tokens at 10% of the normal input rate
(and the labeler runs ~10 concurrent calls, so the cache stays warm).

Expected cache hit rate: ~99% for the system prompt after the first ~10
calls.

---

## Version pinning

The prompt template is versioned via `LABELER_PROMPT_VERSION` in `prompts.ts`.
Every stored label carries the prompt_version field so you can bisect if the
template changes. Bumping the version invalidates the cache prefix and means
cross-version verdict comparisons are apples-to-oranges — do it only for
material wording changes.

---

## Environment reference

```
ANTHROPIC_API_KEY    Required for step 3 (label). Not needed for other steps.
NARK_ADMIN_TOKEN     Required for step 5 (upload). Not needed for any other step.

NARK_TELEMETRY=off   Set automatically by scan-repos.ts to avoid noisy telemetry.
NARK_ALLOW_MISSING_DEPS=1   Set automatically by scan-repos.ts per cloud-scan rule.
```

---

## File layout

```
nark-dev/nark/scripts/benchmark-label/
├── README.md               (this file)
├── tsconfig.json
├── types.ts                shared types
├── prompts.ts              versioned prompt templates
├── rank-candidates.ts      step 1
├── scan-repos.ts           step 2
├── labeler.ts              step 3
└── adjudicate.ts           step 4
```

Runtime state (created at first run, not checked in):

```
~/.nark/benchmark-label/
├── violations/<repo>.json          scan output
├── scan-outputs/<repo>-audit.json  raw nark output
├── labels/<repo>.jsonl             double-blind verdicts
└── labels-final.jsonl              adjudicated gold labels
```

---

## Troubleshooting

**"ANTHROPIC_API_KEY not set"** — set it or pass `--dry-run` to test the
pipeline without hitting the API. Dry-run returns deterministic fake
verdicts.

**"Shortlist not found"** — run `pnpm label:rank` before `pnpm label:scan`.

**"nark not built"** — run `pnpm build` at the nark repo root.

**Repo skipped as "missing on disk"** — you don't have that repo cloned
under `test-repos/`. The pipeline continues with the repos you DO have.

**Repo skipped as "no tsconfig"** — some workspace-root monorepos don't
have a root tsconfig; you'd need to descend into a sub-package. See
Section 4 of `0003-gold-benchmark-candidates.md` for guidance.

**Labeler stuck at 0 / N** — try lowering `--concurrency`. Also verify
your API key has permission to call sonnet-4-6.
