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
  //   Generic close (file handle, connection). Wave 2e (Plan 01-07) reuses this
  //   for puppeteer browser.close()-in-finally suppression — the matcher is
  //   package-agnostic in spirit (any "must close X in finally" guard) but
  //   gates by postcondition shape (`close|leak|handle|connection`).
  FINALLY_CLOSE: "finally:close",
  //   Sentry span lifecycle — `span.end()` must run in finally. Wave 2e (Plan
  //   01-07) records this matcher when the sentry startSpanManual/startInactiveSpan
  //   suppression branches detect the canonical try/finally with span.end()
  //   shape. Gated to @sentry/* span/trace/transaction postconditions.
  FINALLY_SPAN_END: "finally:span-end",
  //   Transaction close — commit/rollback/release in finally.
  FINALLY_TRANSACTION_CLOSE: "finally:transaction-close",

  // Family: framework — Clerk middleware configuration. Wave 2e (Plan 01-07)
  // records this matcher when a Clerk-specific suppression branch detects
  // that clerkMiddleware is properly configured at the project level
  // (middleware.ts + ClerkProvider + protected route group + isLoaded inline
  // guard). Gated to @clerk/nextjs.
  FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED: "framework:clerk-middleware-configured",

  // Family: architectural — project-level architectural patterns that route
  // per-callsite errors to a central handler. Wave 2c (Plan 01-05) adds the
  // data-layer pattern for knex Model-files and typeorm Repository-files when
  // the project also defines a central errorHandler middleware. RESEARCH §3
  // SECTION_10 evidence: lightdash (knex), rsschool-app (typeorm).
  ARCHITECTURAL_DATA_LAYER: "architectural:data-layer-pattern",

  // Family: promise — Promise(executor) callback-err-guard. When the
  // contracted call sits inside `new Promise((resolve, reject) => ...)` and
  // its callback propagates err via reject(err), the rejection surfaces at
  // the outer await — that's where the try/catch belongs, not at the inner
  // registration. Package-agnostic on purpose: canonical promisify shape
  // across mongoose native cb-API, ssh2, snowflake-sdk, and generic
  // node-style cb wrappers.
  // Evidence: 2026-06-23 audit-stream wave 1+2 candidate #4
  // (callback-err-guard-in-promise-wrapper-not-detected).
  PROMISE_EXECUTOR_REJECT: "promise:executor-reject",

  // Family: aws — per-command-family AWS SDK matchers. Wave 2d (Plan 01-06)
  // adds these to the trace surface so the Wave 9 convention miner can spot
  // "this repo wraps all S3 calls in try/catch" or "this repo always handles
  // SQS receive timeouts." Each matcher records `passed` at the canonical
  // OR-chain when the call site is protected by try/catch (or .catch handler,
  // .onError option, destructured-error tuple) AND the package is in the
  // matching @aws-sdk/* family. The AWS command class (e.g. "GetObjectCommand",
  // "SendEmailCommand") is encoded via a colon-suffix on the recorded wire
  // string: `aws:s3-command:GetObjectCommand` is recorded ALONGSIDE the
  // base `aws:s3-command` so the miner can group by family AND drill down by
  // command class without needing a separate index. The base ID stays stable
  // for registry / POSTCONDITION_GATING; the suffixed form is "free-text" and
  // not part of MATCHER_IDS (the accumulator accepts arbitrary record() strings).
  AWS_S3_COMMAND: "aws:s3-command",
  AWS_SES_COMMAND: "aws:ses-command",
  AWS_SESV2_COMMAND: "aws:sesv2-command",
  AWS_SQS_COMMAND: "aws:sqs-command",
  AWS_SNS_COMMAND: "aws:sns-command",
  AWS_DYNAMODB_COMMAND: "aws:dynamodb-command",
  AWS_SECRETS_MANAGER_COMMAND: "aws:secrets-manager-command",
  AWS_BEDROCK_INVOKE: "aws:bedrock-invoke",
  AWS_LAMBDA_INVOKE: "aws:lambda-invoke",
  AWS_CLOUDWATCH_LOG_EVENT: "aws:cloudwatch-log-event",
  AWS_LIB_STORAGE_UPLOAD: "aws:lib-storage-upload",
  AWS_S3_PRESIGNER: "aws:s3-presigner",
} as const;

/**
 * Alias retained for callers that imported a "sentry-lifecycle" name. The
 * sentry span lifecycle matcher is recorded under FINALLY_SPAN_END today.
 * Listed via `as const` (re-export) rather than a duplicate value so
 * downstream typeof checks remain stable.
 */
export const SENTRY_LIFECYCLE = MATCHER_IDS.FINALLY_SPAN_END;

/**
 * Wave 2e (Plan 01-07) aliases for the lifecycle-special suppression branches
 * in contract-matcher.ts. These re-export the canonical IDs under
 * package-suggestive names so the suppression branches read clearly. Wire
 * strings are unchanged — downstream readers see `finally:span-end` /
 * `finally:close` either way.
 */
export const SENTRY_FINALLY_SPAN_END = MATCHER_IDS.FINALLY_SPAN_END;
export const PUPPETEER_FINALLY_CLOSE = MATCHER_IDS.FINALLY_CLOSE;
export const CLERK_MIDDLEWARE_CONFIGURED =
  MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED;

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
  // substring. Plan 01-08 adds its family below.
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

  // Wave 2c (Plan 01-05) — architectural data-layer pattern: gated to knex
  // and typeorm because the SECTION_10 evidence base (lightdash, rsschool-app)
  // only validates these two packages. Plan 01-08 (long-tail) may widen to
  // prisma model-class pattern when empirical evidence ships.
  [MATCHER_IDS.ARCHITECTURAL_DATA_LAYER]: (c) =>
    c.packageName === "knex" || c.packageName === "typeorm",

  // Wave 2c (Plan 01-05) — Promise(executor) callback-err-guard. Applies
  // broadly to any package whose contracted call site can sit inside a
  // `new Promise((resolve, reject) => ...)` executor. Most observed cases
  // are DB drivers using the native callback API (mongoose, mysql2, pg) plus
  // the ssh2 / snowflake-sdk / generic cb-promisify shape. Not package-gated:
  // the predicate matches any package that has a callback-shaped contract.
  [MATCHER_IDS.PROMISE_EXECUTOR_REJECT]: () => true,

  // Wave 2d (Plan 01-06) — AWS SDK per-command-family matchers. Each gate
  // narrows applicability to the specific @aws-sdk/* package family. The
  // command class (e.g. "GetObjectCommand") is recorded ALONGSIDE the base
  // matcher via a colon-suffixed wire string — that suffixed string is NOT
  // gated here (it falls through to the default-true) because the per-command
  // applicability is structural (the AST argument inspection at the canonical
  // OR-chain). The base matcher gate below ensures the not_applicable surface
  // for non-AWS callsites stays clean.
  [MATCHER_IDS.AWS_S3_COMMAND]: (c) =>
    c.packageName === "@aws-sdk/client-s3" ||
    c.packageName === "@aws-sdk/lib-storage" ||
    c.packageName === "@aws-sdk/s3-request-presigner",
  [MATCHER_IDS.AWS_SES_COMMAND]: (c) => c.packageName === "@aws-sdk/client-ses",
  [MATCHER_IDS.AWS_SESV2_COMMAND]: (c) => c.packageName === "@aws-sdk/client-sesv2",
  [MATCHER_IDS.AWS_SQS_COMMAND]: (c) => c.packageName === "@aws-sdk/client-sqs",
  [MATCHER_IDS.AWS_SNS_COMMAND]: (c) => c.packageName === "@aws-sdk/client-sns",
  [MATCHER_IDS.AWS_DYNAMODB_COMMAND]: (c) =>
    c.packageName === "@aws-sdk/client-dynamodb",
  [MATCHER_IDS.AWS_SECRETS_MANAGER_COMMAND]: (c) =>
    c.packageName === "@aws-sdk/client-secrets-manager",
  [MATCHER_IDS.AWS_BEDROCK_INVOKE]: (c) =>
    c.packageName === "@aws-sdk/client-bedrock-runtime",
  [MATCHER_IDS.AWS_LAMBDA_INVOKE]: (c) => c.packageName === "@aws-sdk/client-lambda",
  [MATCHER_IDS.AWS_CLOUDWATCH_LOG_EVENT]: (c) =>
    c.packageName === "@aws-sdk/client-cloudwatch-logs",
  [MATCHER_IDS.AWS_LIB_STORAGE_UPLOAD]: (c) =>
    c.packageName === "@aws-sdk/lib-storage",
  [MATCHER_IDS.AWS_S3_PRESIGNER]: (c) =>
    c.packageName === "@aws-sdk/s3-request-presigner",

  // Pitfall 7 from RESEARCH: a try/catch around `Sentry.startSpanManual(...)`
  // is NOT a substitute for `span.end()` in finally. TRY_CATCH_DIRECT must
  // NOT apply to sentry span-lifecycle postconditions even though the call
  // sits inside a try/catch. For non-sentry contexts the matcher applies.
  //
  // Wave 2e (Plan 01-07): the SAME Pitfall 7 logic generalises to the other
  // three OR-chain matchers (PROMISE_CATCH_HANDLER / OPTIONS_ON_ERROR /
  // DESTRUCTURED_ERROR_TUPLE). A .catch() on the outer promise still leaks
  // the inner span; an `{onError}` option likewise; a Go-style tuple
  // destructure on the outer await likewise. The contract-matcher's
  // canonical OR-chain DELIBERATELY skips recording all four matchers for
  // sentry-lifecycle postconditions so serialize() Pass 2 emits them as
  // not_applicable. These predicate gates are the registry-side belt-and-
  // suspenders — if a future code path forgets the skip, the gate still
  // signals the matcher is conceptually not_applicable.
  [MATCHER_IDS.TRY_CATCH_DIRECT]: (c) =>
    !(
      c.packageName.startsWith("@sentry/") &&
      /span|trace|transaction/i.test(c.postconditionId)
    ),
  [MATCHER_IDS.PROMISE_CATCH_HANDLER]: (c) =>
    !(
      c.packageName.startsWith("@sentry/") &&
      /span|trace|transaction/i.test(c.postconditionId)
    ),
  [MATCHER_IDS.OPTIONS_ON_ERROR]: (c) =>
    !(
      c.packageName.startsWith("@sentry/") &&
      /span|trace|transaction/i.test(c.postconditionId)
    ),
  [MATCHER_IDS.DESTRUCTURED_ERROR_TUPLE]: (c) =>
    !(
      c.packageName.startsWith("@sentry/") &&
      /span|trace|transaction/i.test(c.postconditionId)
    ),

  // Wave 2e (Plan 01-07) — Clerk middleware-configured matcher. Applies only
  // to @clerk/nextjs postconditions. The matcher is recorded by the clerk
  // suppression branches in contract-matcher.ts when the project has a valid
  // middleware.ts + clerkMiddleware default export (file-system probe).
  [MATCHER_IDS.FRAMEWORK_CLERK_MIDDLEWARE_CONFIGURED]: (c) =>
    c.packageName === "@clerk/nextjs",
};

export function applicabilityPredicate(
  matcherId: string,
  ctx: ApplicabilityContext,
): boolean {
  const gate = POSTCONDITION_GATING[matcherId];
  // Ungated matchers (broadly-applicable: PROMISE_CATCH_HANDLER, OPTIONS_ON_ERROR,
  // DESTRUCTURED_ERROR_TUPLE, RESPONSE_OK_GUARD, RESULT_NULL_GUARD,
  // CALLBACK_TRY_CATCH, and any unknown matcher) always apply.
  // PROMISE_EXECUTOR_REJECT is registered with an `always true` gate (Wave 2c)
  // because its applicability is structural (callback-shaped contract) rather
  // than per-package — the runtime check happens at the AST walker.
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
