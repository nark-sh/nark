/**
 * Matcher Registry — Wave 0 scaffolding for detection-trace.
 *
 * Single source of truth for stable wire-string identifiers used by the
 * V2 ContractMatcher when it records `detectionTrace[]` entries on a
 * Violation. The contract-matcher and convention-miner (Wave 1 + Wave 3
 * consumers) import these constants instead of inlining string literals
 * so a rename happens in one place.
 *
 * Additive contract (DO NOT BREAK):
 *   - Each value in MATCHER_IDS is part of the persisted Violation surface.
 *     Once an analyzer build has emitted a violation carrying
 *     `detectionTrace[].matcher === "try-catch:direct"`, downstream
 *     consumers (Wave 3 convention-miner, Wave 5 SARIF writer, SaaS
 *     ViolationView UI) may persist or surface that string verbatim.
 *     Therefore the *wire value* MUST NOT change meaning. New matchers may
 *     be added; existing values may not be repurposed.
 *   - If a matcher must be renamed for clarity, ADD the new identifier and
 *     register the old → new mapping in `LEGACY_MATCHER_ID_ALIASES` so a
 *     consumer can normalize older traces forward.
 *
 * Naming convention:
 *   `<family>:<specifier>`  — lowercase, hyphens within a token, colon as
 *   the family separator. Examples: `try-catch:direct`, `framework:fastify-route`.
 *
 * Reference: plan 01-01, Wave 0 (RESEARCH §4 + Open Question #3).
 */

// ──────────────────────────────────────────────────────────────────────────────
// Canonical matcher identifiers
// ──────────────────────────────────────────────────────────────────────────────

export const MATCHER_IDS = {
  // Family: try-catch — direct call inside a try/catch block.
  TRY_CATCH_DIRECT: "try-catch:direct",

  // Family: promise — explicit .catch() handler on a Promise chain.
  PROMISE_CATCH_HANDLER: "promise:catch-handler",

  // Family: options — error handler passed in an options bag (e.g. `{ onError }`).
  OPTIONS_ON_ERROR: "options:on-error",

  // Family: destructured-error — Go-style `[err, value] = await ...` tuple.
  DESTRUCTURED_ERROR_TUPLE: "destructured-error:tuple",

  // Family: guard — narrowing checks BEFORE a follow-up call.
  //   response.ok / response.status guard before .json()/.text().
  RESPONSE_OK_GUARD: "guard:response-ok",
  //   null/undefined guard before consuming a result value.
  RESULT_NULL_GUARD: "guard:null-check",

  // Family: callback — async callback whose body is fully wrapped in try/catch.
  CALLBACK_TRY_CATCH: "callback:async-wrapped-try-catch",

  // Family: framework — framework-level "catches all errors" idioms.
  //   `express-async-errors` import side-effect at app entry.
  FRAMEWORK_EXPRESS_ASYNC_ERRORS: "framework:express-async-errors",
  //   Fastify route handler — framework wraps handler in a try/catch.
  FRAMEWORK_FASTIFY_ROUTE: "framework:fastify-route",
  //   react-hook-form `setError` after a failed mutation.
  FRAMEWORK_REACT_HOOK_FORM: "framework:react-hook-form-set-error",
  //   @tanstack/react-query `onError` callback in mutation options.
  FRAMEWORK_REACT_QUERY: "framework:react-query-on-error",

  // Family: finally — required cleanup in a finally block.
  //   Generic close (file handle, connection).
  FINALLY_CLOSE: "finally:close",
  //   Sentry span lifecycle — `span.end()` must run in finally.
  FINALLY_SPAN_END: "finally:span-end",
  //   Transaction close — commit/rollback/release in finally.
  FINALLY_TRANSACTION_CLOSE: "finally:transaction-close",
} as const;

/**
 * Alias retained for callers that imported a "sentry-lifecycle" name. The
 * sentry span lifecycle matcher is recorded under FINALLY_SPAN_END today.
 * Listed via `as const` (re-export) rather than a duplicate value so
 * downstream typeof checks remain stable.
 */
export const SENTRY_LIFECYCLE = MATCHER_IDS.FINALLY_SPAN_END;

// ──────────────────────────────────────────────────────────────────────────────
// Type surface
// ──────────────────────────────────────────────────────────────────────────────

/**
 * String-union of every value in MATCHER_IDS. Used wherever a value
 * needs to be typed as "a known matcher identifier" — e.g. the future
 * Violation.detectionTrace entries (Wave 1).
 */
export type MatcherId = (typeof MATCHER_IDS)[keyof typeof MATCHER_IDS];

/**
 * Tri-state status of a matcher relative to a single call site / postcondition.
 *   - passed         : matcher fired and the call site is considered protected.
 *   - failed         : matcher was applicable but did NOT find protection.
 *   - not_applicable : matcher does not apply to this postcondition or package
 *                      (recorded explicitly so a violation surface shows the
 *                      reader that we considered the matcher and skipped it).
 */
export type MatcherStatus = "passed" | "failed" | "not_applicable";

// ──────────────────────────────────────────────────────────────────────────────
// Applicability predicates
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to applicabilityPredicate. Kept intentionally minimal so the
 * Wave 1 trace finalizer can populate it cheaply.
 */
export interface ApplicabilityContext {
  /** Package name from the matched contract, e.g. "axios", "@sentry/node". */
  packageName: string;
  /** Postcondition ID from the matched contract, e.g. "error-4xx-5xx". */
  postconditionId: string;
}

/**
 * Per-matcher applicability rules. Default: a matcher applies to most
 * postconditions; framework-gated and lifecycle-gated matchers return false
 * unless the package/postcondition signals match.
 *
 * The Wave 1 trace finalizer uses this predicate to decide whether the
 * matcher is relevant to a (packageName, postconditionId) context. As of
 * Plan 01-04 (Wave 2b), the accumulator's serialize() Pass 2 always emits
 * `not_applicable` for ANY unrecorded matcher in the registry — this
 * predicate is consulted directly by Wave 0 tests and by external callers
 * who want to know "should I bother running this matcher?" but the
 * accumulator no longer gates by it (it surfaces the matcher either way so
 * the trace stays auditable).
 *
 * POSTCONDITION_GATING (Wave 2b) replaces the prior switch: a per-matcher
 * predicate lookup table. Framework matchers now gate by BOTH package and
 * postcondition substring; broadly-applicable matchers omit a gate (default
 * true). This shape unblocks Plans 01-04..01-08 — they can add new gated
 * matchers by appending an entry without touching the switch.
 *
 * IMPORTANT: This is conservative on purpose. New matchers default to
 * "applies broadly" unless they have an explicit gate; teams adding a new
 * gated matcher must extend POSTCONDITION_GATING. Wave 2's matcher unit
 * tests pin no new matcher is silently broad.
 */
type GatePredicate = (ctx: ApplicabilityContext) => boolean;

const POSTCONDITION_GATING: Record<string, GatePredicate> = {
  // Framework matchers — gated by package AND (where useful) by postcondition
  // substring. Plans 01-05..01-08 add their families below.
  [MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS]: (c) =>
    c.packageName === "express" &&
    (c.postconditionId.includes("async-middleware") ||
      c.postconditionId.includes("async-route-handler") ||
      c.postconditionId.includes("async-router") ||
      c.postconditionId.includes("express-async")),
  [MATCHER_IDS.FRAMEWORK_FASTIFY_ROUTE]: (c) => c.packageName === "fastify",
  [MATCHER_IDS.FRAMEWORK_REACT_HOOK_FORM]: (c) =>
    c.packageName === "react-hook-form",
  [MATCHER_IDS.FRAMEWORK_REACT_QUERY]: (c) =>
    c.packageName === "@tanstack/react-query" ||
    c.packageName === "react-query",

  // Lifecycle / finally-gated matchers — postcondition-shape based.
  [MATCHER_IDS.FINALLY_SPAN_END]: (c) =>
    c.packageName.startsWith("@sentry/") &&
    /span|trace|transaction/i.test(c.postconditionId),
  [MATCHER_IDS.FINALLY_TRANSACTION_CLOSE]: (c) =>
    /transaction|commit|rollback|release/i.test(c.postconditionId),
  [MATCHER_IDS.FINALLY_CLOSE]: (c) =>
    /close|leak|handle|connection/i.test(c.postconditionId),

  // Pitfall 7 from RESEARCH: a try/catch around `Sentry.startSpanManual(...)`
  // is NOT a substitute for `span.end()` in finally. TRY_CATCH_DIRECT must
  // NOT apply to sentry span-lifecycle postconditions even though the call
  // sits inside a try/catch. For non-sentry contexts the matcher applies.
  [MATCHER_IDS.TRY_CATCH_DIRECT]: (c) =>
    !(
      c.packageName.startsWith("@sentry/") &&
      /span|trace|transaction/i.test(c.postconditionId)
    ),
};

export function applicabilityPredicate(
  matcherId: string,
  ctx: ApplicabilityContext,
): boolean {
  const gate = POSTCONDITION_GATING[matcherId];
  // Ungated matchers (broadly-applicable: PROMISE_CATCH_HANDLER, OPTIONS_ON_ERROR,
  // DESTRUCTURED_ERROR_TUPLE, RESPONSE_OK_GUARD, RESULT_NULL_GUARD,
  // CALLBACK_TRY_CATCH, and any unknown matcher) always apply.
  return gate ? gate(ctx) : true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Legacy aliases
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Forward-compat shim. Empty for Wave 0. When a matcher id needs to be
 * renamed, add an entry mapping `<old-string>` → `<new MatcherId>` so older
 * persisted traces (in audit-history.json, SARIF logs, SaaS DB rows) can be
 * normalized forward on read.
 *
 * Example:
 *   LEGACY_MATCHER_ID_ALIASES["try-catch:wrap"] = MATCHER_IDS.TRY_CATCH_DIRECT;
 */
export const LEGACY_MATCHER_ID_ALIASES: Record<string, MatcherId> = {};

/**
 * Normalize a possibly-legacy matcher id to its current canonical value.
 * Returns the input unchanged if it is already canonical or unknown.
 */
export function normalizeMatcherId(raw: string): string {
  return LEGACY_MATCHER_ID_ALIASES[raw] ?? raw;
}

// ──────────────────────────────────────────────────────────────────────────────
// Convenience helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns every canonical matcher id in MATCHER_IDS, ordered as declared.
 * Useful for the trace finalizer which iterates the full set and emits
 * either `passed` / `failed` / `not_applicable` for each.
 */
export function allMatcherIds(): readonly MatcherId[] {
  return Object.values(MATCHER_IDS) as MatcherId[];
}

/**
 * Returns true if the given string is a known canonical matcher id.
 */
export function isKnownMatcherId(raw: string): raw is MatcherId {
  return (Object.values(MATCHER_IDS) as string[]).includes(raw);
}
