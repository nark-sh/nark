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

1. Two independent labelers per violation, spawned as parallel Claude Code
   background agents with fresh contexts per batch.
2. Both labelers see the same reasoning-from-first-principles prompt with
   NO reference to a scanner verdict; the second labeler receives the
   batch in reverse order to reduce positional bias.
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

Env needed:  none         none    none          none        NARK_ADMIN_
                                  (runs in                  TOKEN
                                  Claude Code)
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

Labeling runs inside a Claude Code session via the `bc-benchmark-label`
skill. Each invocation processes ONE batch of ~30 violations, then exits.
Re-invoke for the next batch (same pattern as `bc-coordinator`).

Per batch, the skill spawns two Claude Code background agents in parallel:

- **Labeler-A** — fresh context, blind labeling prompt, batch input in order
- **Labeler-B** — fresh context, same prompt, batch input in reverse (to
  reduce positional bias)

Both agents reason from first principles about code + package docs. Neither
sees nark's verdict, and neither sees the other labeler's verdict.
Aggregation is pure arithmetic in the skill orchestrator:

- both TP → `agreed_TP`
- both FP → `agreed_FP`
- split TP/FP → `disagree`
- any undecidable → `escalate`

Writes JSONL incrementally per batch so a crash loses at most one batch.
Re-invoking resumes by skipping violations already labeled.

```
# Inside a Claude Code session:
/bc-benchmark-label                # process next batch (~30 violations)
/bc-benchmark-label cal.com        # single-repo focus
```

Optionally wrap with `/loop /bc-benchmark-label` to run the batches back to
back without re-typing.

**No API keys.** The skill runs entirely on the parent Claude Code session
+ its background agents. The $200/mo Max plan covers it. NO
`ANTHROPIC_API_KEY` required. NO project code imports an AI SDK.

Prompt template lives at `.claude/skills/bc-benchmark-label/prompt-template.md`
(version tag `LABELER_PROMPT_VERSION: 2026-07-03.v2`) and every stored
label carries the `prompt_version` field for cross-version bisection.

Live progress printed at exit of each wave:
`labeled batch of 30 for cal.com: 21 agreed_TP · 5 agreed_FP · 3 disagree · 1 escalate · 47 remaining`

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

If a labeling wave is killed mid-flight, the JSONL file contains complete
lines for everything already labeled in prior waves. Re-invoke
`/bc-benchmark-label` to pick up where you left off — the skill filters
out already-labeled IDs before selecting the next batch.

---

## Cost estimate

**$0 marginal.** Labeling runs inside a Claude Code session via the
`bc-benchmark-label` skill and two background agents per wave. The $200/mo
Max plan covers everything.

The prior SDK-based labeler (deleted 2026-07-03) estimated ~$40 for the
top-50 shortlist at Sonnet-only, ~$70 with Opus tiebreaker. That path was
removed because it violated the rule that nark project code stays
LLM-free: the Anthropic SDK was a devDep of `nark-dev/nark` and burned
separate API credit for what the Max plan already covers via Claude Code.

Wall-clock cost is roughly one wave every couple minutes (two background
agents run in parallel; each processes ~30 violations per call). For ~1300
violations across the top-50 shortlist that's ~45 waves, achievable in a
long afternoon of `/loop /bc-benchmark-label`.

---

## Version pinning

The prompt template lives at
`.claude/skills/bc-benchmark-label/prompt-template.md` and is versioned
via `LABELER_PROMPT_VERSION`. Every stored label carries the
prompt_version field so you can bisect if the template changes.
Cross-version verdict comparisons are apples-to-oranges — bump the version
only for material wording changes.

Current version: `2026-07-03.v2` (batch-mode, background-agent delivery).
Previous: `2026-07-02.v1` (SDK, single-call).

---

## Environment reference

```
NARK_ADMIN_TOKEN     Required for step 5 (upload). Not needed for any other step.

NARK_TELEMETRY=off   Set automatically by scan-repos.ts to avoid noisy telemetry.
NARK_ALLOW_MISSING_DEPS=1   Set automatically by scan-repos.ts per cloud-scan rule.
```

Notably absent: no `ANTHROPIC_API_KEY`. The labeling step runs inside
Claude Code and requires no API keys.

---

## File layout

```
nark-dev/nark/scripts/benchmark-label/
├── README.md               (this file)
├── tsconfig.json
├── types.ts                shared types
├── rank-candidates.ts      step 1
├── scan-repos.ts           step 2
└── adjudicate.ts           step 4

.claude/skills/bc-benchmark-label/
├── SKILL.md                step 3 orchestrator
└── prompt-template.md      versioned labeling prompt
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

**"Shortlist not found"** — run `pnpm label:rank` before `pnpm label:scan`.

**"nark not built"** — run `pnpm build` at the nark repo root.

**Repo skipped as "missing on disk"** — you don't have that repo cloned
under `test-repos/`. The pipeline continues with the repos you DO have.

**Repo skipped as "no tsconfig"** — some workspace-root monorepos don't
have a root tsconfig; you'd need to descend into a sub-package. See
Section 4 of `0003-gold-benchmark-candidates.md` for guidance.

**`/bc-benchmark-label` prints "no violations to label"** — either you
haven't run `pnpm label:scan` yet, or every violation has already been
labeled. Run `pnpm label:adjudicate` next.

**Labeler agent returns malformed JSON** — the skill orchestrator marks
affected violations as `escalate` with a note; the wave still completes
for the rest of the batch. Re-invoke `/bc-benchmark-label` and it will
re-attempt (the JSONL append only records successful pairs).
