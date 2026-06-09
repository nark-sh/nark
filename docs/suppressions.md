# Suppressions

How to tell Nark to ignore a violation, and what makes a suppression honest.

Nark profiles describe what a package can fail at. The scanner flags call
sites that don't handle those failure modes. Some of those flags will be
false positives — a wrapper, a framework boundary, or a deliberately accepted
risk. Suppressions are the mechanism for marking those as "we looked,
we know, here is why we're not handling it." Every suppression carries a
required `reason` field so the justification lives in the commit and gets
reviewed alongside the code.

## Two ways to suppress

### 1. `.nark/suppressions.json` (recommended)

A repo-committed JSON file at the project root. Best for suppressions that
apply repo-wide or to a whole subtree.

```json
{
  "ignore": [
    {
      "package": "next",
      "postconditionId": "require-error-handling",
      "reason": "Next.js route handlers wrap thrown errors into 500s — error handling is centralized in app/error.tsx"
    },
    {
      "package": "stripe",
      "postconditionId": "require-error-handling",
      "file": "apps/web/lib/stripe-wrapper.ts",
      "reason": "All stripe calls in this codebase go through stripe-wrapper.ts which catches and normalizes errors"
    }
  ]
}
```

**Fields:**

| Field             | Required | Notes                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------- |
| `package`         | no       | Package name (e.g. `axios`, `@prisma/client`). Omit to match any.     |
| `postconditionId` | no       | Postcondition ID from the violation (e.g. `require-error-handling`). |
| `file`            | no       | Glob pattern (e.g. `src/**/*.ts`, `apps/web/lib/stripe.ts`).         |
| `reason`          | **yes**  | Minimum 10 characters. Must explain *why* this is suppressed.        |

A rule with all three of `package`, `postconditionId`, and `file` omitted
will suppress everything — don't do that.

**Adding via CLI** (preferred over hand-editing — it dedupes and validates):

```bash
nark suppressions add \
  --package stripe \
  --postcondition require-error-handling \
  --file "apps/web/lib/stripe-wrapper.ts" \
  --reason "All stripe calls go through stripe-wrapper.ts which normalizes errors"
```

### 2. Inline comment suppression

Best for one-off suppressions next to the specific call site. The comment
must appear on the line directly above the call.

```ts
// @behavioral-contract-ignore axios/network-failure: handled by global retry interceptor in lib/http.ts
const response = await axios.get(url);
```

**Format:**

```
// @behavioral-contract-ignore <package>/<postcondition-id>: <reason>
```

**Wildcards:**

- `// @behavioral-contract-ignore */network-failure: reason` — any package, this postcondition
- `// @behavioral-contract-ignore stripe/*: reason` — all stripe postconditions on this line

`*/*` is valid syntax but flagged with a warning — it suppresses every
postcondition on the line, which is rarely what you want.

> The inline-comment keyword `@behavioral-contract-ignore` is a stable
> on-disk identifier; renaming it would break every project that already
> uses it. The user-facing name for the system is "Nark profile
> suppressions."

## The `reason` field

Required everywhere. Minimum 10 characters. The point is that someone
reading the diff six months later understands the call.

**Bad reasons** (won't survive review):

- `"false positive"`
- `"not applicable"`
- `"TODO fix later"`
- `"handled elsewhere"`

**Good reasons** (concrete and verifiable):

- `"Next.js route handlers wrap thrown errors into 500s — centralized in app/error.tsx"`
- `"Stripe webhook receivers run inside express-async-handler which forwards to error middleware at app.ts:42"`
- `"This is intentional fire-and-forget telemetry — failure here is acceptable and logged via Sentry breadcrumb"`

A reviewer should be able to read the reason, look at the code, and confirm
the claim without asking the author.

## Suppression scoping cheat sheet

| Scope                  | Use                                                      |
| ---------------------- | -------------------------------------------------------- |
| One specific call site | Inline comment                                           |
| One file               | `.nark/suppressions.json` with `file: "path/to/file.ts"` |
| One subtree            | `.nark/suppressions.json` with `file: "src/legacy/**"`   |
| Entire repo            | `.nark/suppressions.json` with `package` + `postconditionId`, no `file` |

Prefer the narrowest scope that fits. A repo-wide suppression for
`stripe/require-error-handling` will silence the next real bug.

## CLI commands

```bash
# List all suppressions across inline comments + config file
nark suppressions list

# Show only active suppressions (still match a current violation)
nark suppressions list --active

# Show only dead suppressions (no longer match anything — safe to remove)
nark suppressions list --dead

# Show details for one suppression
nark suppressions show src/lib/foo.ts:42

# Add a rule to .nark/suppressions.json
nark suppressions add --package <name> --postcondition <id> --reason "<why>"

# Suppression stats: total, active, dead, breakdown by package
nark suppressions stats

# Detect dead suppressions (preview only)
nark suppressions clean

# Remove dead suppressions from the manifest
nark suppressions clean --auto
```

`nark suppressions clean` is the maintenance command. Run it periodically
(or wire it into CI with `--fail-on-dead-suppressions`) so the manifest
doesn't accumulate stale entries from profile tightening or code that's
been deleted.

## Dead suppression detection

When the corpus releases a tighter profile, some past suppressions stop
matching anything — there is no violation to suppress anymore. Those are
"dead" and should be removed so the manifest reflects what's actually
suppressed.

```bash
# Find dead suppressions
nark suppressions clean

# Remove them from .nark/suppressions.json
nark suppressions clean --auto

# Hard-fail CI on dead suppressions
nark --fail-on-dead-suppressions --tsconfig tsconfig.json
```

The `--check-dead-suppressions` flag on a normal `nark` run will report
dead suppressions without failing — useful while you're still rolling out
the discipline.

## Integration with the PR bot

When a PR is scanned by the [Nark GitHub App](https://github.com/marketplace/nark),
the PR comment reflects only **non-suppressed** violations. Suppressions
committed to `.nark/suppressions.json` and inline comments in the diff are
both honored. The bot's comment headline (e.g. `0 newly written · 0 newly
surfaced · 3 resolved`) reflects post-suppression counts; the GitHub check
conclusion follows the same logic.

This means the typical Phase-2 rollout pattern works as intended: walk
the baseline, suppress with reasons, drop `continue-on-error`, and the
bot then enforces only the net-new gaps the PR introduced.

## Anti-patterns

- **Blanket `*/*` inline suppressions** — silences everything on the line
  including future findings. Use a specific package/postcondition pair.
- **Wildcard `package` rules with no `file` scope** — silences across the
  whole repo. Almost never the right scope.
- **Suppressing without a reason that survives review** — `"fp"` is not a
  reason. The schema rejects reasons under 10 chars, but the discipline
  of writing one a reviewer can verify is what makes the suppression
  honest.
- **Leaving dead suppressions in the manifest** — they erode trust in the
  set. Run `nark suppressions clean --auto` periodically.

## See also

- [README — Rollout pattern](../README.md#--diff-line-level-filtering) —
  the three-phase rollout (report → triage → enforce)
- [`.nark/config.yaml`](../README.md#configuration-file) — other CLI
  options you can persist alongside suppressions
- [nark.sh/recommended-rollout](https://www.nark.sh/recommended-rollout) —
  the marketing-side walkthrough of the same rollout pattern
