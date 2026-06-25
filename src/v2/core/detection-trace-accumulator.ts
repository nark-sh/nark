/**
 * DetectionTraceAccumulator — Wave 1 (Plan 01-02 Task 2).
 *
 * Per-violation buffer that records which matchers passed / failed and
 * which were not_applicable, then serializes to the canonical wire shape
 * Violation.detectionTrace[] expects.
 *
 * USAGE (Wave 2 — plans 01-03..01-08 will instantiate one per loop
 * iteration in src/v2/core/contract-matcher.ts):
 *
 *     const acc = new DetectionTraceAccumulator({
 *       packageName: contract.package,
 *       postconditionId: postcondition.id,
 *     });
 *
 *     // ... matcher attempts ...
 *     if (isInTryCatch(node)) {
 *       acc.record(MATCHER_IDS.TRY_CATCH_DIRECT, "passed");
 *     } else {
 *       acc.record(MATCHER_IDS.TRY_CATCH_DIRECT, "failed", "no try");
 *     }
 *
 *     if (hasPromiseCatch(node)) {
 *       acc.record(MATCHER_IDS.PROMISE_CATCH_HANDLER, "passed");
 *     } else {
 *       acc.record(MATCHER_IDS.PROMISE_CATCH_HANDLER, "failed", "no .catch()");
 *     }
 *     // ... other matchers ...
 *
 *     violation.detectionTrace = acc.serialize();
 *
 * IMPORTANT (Pitfall 1 from RESEARCH.md):
 *   Callers MUST break OR-chains into N sequential record() calls — one
 *   record() per matcher considered, not one record() per OR-branch.
 *   Today, contract-matcher.ts evaluates `tryCatch || promiseCatch ||
 *   onError || ...` inside a single `if`. Wave 2 will rewire those into
 *   sequential record() calls so the trace captures EVERY matcher's
 *   outcome, not just the first short-circuit hit. The accumulator does
 *   NOT enforce this (it can't — it doesn't see the source AST), so the
 *   contract lives at the call site.
 *
 * SERIALIZE CONTRACT:
 *   - Pass 1: emit every recorded (passed | failed) entry in insertion
 *     order. Duplicates keep the LAST value (Map semantics).
 *   - Pass 2: walk the full MATCHER_IDS registry; for each matcher NOT
 *     already recorded, consult applicabilityPredicate(matcher, ctx) —
 *     if true, emit a not_applicable entry; if false, omit entirely.
 *   - `reason` field is included ONLY on failed entries. Passed and
 *     not_applicable entries strip it.
 *   - serialize() is idempotent — the internal Map is read-only on
 *     serialize(), and the registry walk is deterministic on Object.values.
 */

import type { MatcherId } from "../matchers/registry.js";
import {
  MATCHER_IDS,
  applicabilityPredicate,
} from "../matchers/registry.js";
import type { DetectionTraceEntry } from "../types/index.js";

/**
 * Context the accumulator needs to consult applicabilityPredicate.
 * Kept intentionally minimal (mirrors ApplicabilityContext in registry.ts).
 */
export interface AccumulatorCtx {
  packageName: string;
  postconditionId: string;
}

/**
 * Internal record shape. Status is only "passed" or "failed" here;
 * "not_applicable" entries are computed by serialize() from the registry
 * walk and are never stored.
 */
interface RecordedEntry {
  status: "passed" | "failed";
  reason?: string;
}

export class DetectionTraceAccumulator {
  private readonly recorded = new Map<string, RecordedEntry>();

  constructor(private readonly ctx: AccumulatorCtx) {}

  /**
   * Record the outcome of a single matcher for this (callsite, postcondition).
   *
   * @param matcherId  canonical wire string from MATCHER_IDS (or a custom
   *                   string for forward-compat; serialize() trusts the
   *                   caller and emits the string verbatim).
   * @param status     "passed" — matcher fired; the call is protected.
   *                   "failed" — matcher was considered and did NOT find
   *                   protection.
   * @param reason     Optional human/machine-readable note. Per the wire
   *                   schema, reason is preserved ONLY on failed entries;
   *                   serialize() strips it from passed entries even if
   *                   the caller passed one.
   *
   * Duplicate calls for the same matcherId keep the LAST value. Wave 2
   * tests pin this so refactors can rely on it.
   */
  record(
    matcherId: MatcherId | string,
    status: "passed" | "failed",
    reason?: string,
  ): void {
    if (status === "failed") {
      this.recorded.set(matcherId, { status, reason });
    } else {
      // Strip reason — schema says reason is only for failed entries.
      this.recorded.set(matcherId, { status });
    }
  }

  /**
   * Serialize the accumulator to the wire shape Violation.detectionTrace
   * expects. Idempotent — calling twice returns deep-equal arrays
   * (independent objects, same content).
   */
  serialize(): DetectionTraceEntry[] {
    const entries: DetectionTraceEntry[] = [];

    // Pass 1: recorded passed/failed entries in insertion order.
    for (const [matcher, rec] of this.recorded) {
      if (rec.status === "failed" && rec.reason !== undefined) {
        entries.push({ matcher, status: "failed", reason: rec.reason });
      } else {
        entries.push({ matcher, status: rec.status });
      }
    }

    // Pass 2: not_applicable entries for every registered matcher the
    // caller never record()-ed. Walking Object.values(MATCHER_IDS) is
    // deterministic — declaration order is preserved by JavaScript object
    // semantics (matched-key insertion order on the const-as-object).
    //
    // WAVE-2B (Plan 01-04): the predicate gate was REMOVED here so the
    // trace surface is complete and auditable. A consumer (Wave 9
    // convention miner, SaaS UI, future SARIF writer) needs to be able to
    // tell "we considered FRAMEWORK_EXPRESS_ASYNC_ERRORS for this axios
    // callsite and it didn't apply" — that requires the entry to appear
    // as `not_applicable`, not silently absent. The applicabilityPredicate
    // remains available for external callers ("should I bother running
    // this matcher?") but no longer filters the trace itself.
    //
    // The void below silences TS6133 ("declared but never read") because
    // applicabilityPredicate is still imported for the JSDoc reference
    // above and for external callers via re-export downstream.
    void applicabilityPredicate;
    for (const wireString of Object.values(MATCHER_IDS)) {
      if (this.recorded.has(wireString)) continue;
      entries.push({ matcher: wireString, status: "not_applicable" });
    }

    return entries;
  }
}
