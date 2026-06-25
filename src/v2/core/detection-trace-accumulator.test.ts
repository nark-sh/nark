/**
 * DetectionTraceAccumulator — unit tests (Wave 1, Plan 01-02 Task 2).
 *
 * These tests pin the accumulator semantics that Wave 2 (matcher
 * rewiring, plans 01-03..01-08) will rely on:
 *   - record() captures passed / failed entries
 *   - serialize() emits not_applicable for registered matchers that ARE
 *     applicable to (packageName, postconditionId) but were not recorded
 *   - serialize() omits matchers whose applicabilityPredicate is false
 *   - reason is ONLY present on failed entries (passed strips it)
 *   - duplicate record() of the same matcher keeps the LAST value
 *   - serialize() is idempotent (Wave 2 callers may serialize once per
 *     violation; some plugins may serialize twice during dual-pass)
 *
 * The accumulator does NOT enforce that callers break OR-chains into
 * sequential record() calls — that's a Wave 2 contract (Pitfall 1 in
 * RESEARCH.md). These tests pin only the accumulator's own contract.
 */

import { describe, it, expect } from "vitest";
import { DetectionTraceAccumulator } from "./detection-trace-accumulator.js";
import {
  MATCHER_IDS,
  applicabilityPredicate,
} from "../matchers/registry.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const AXIOS_CTX = {
  packageName: "axios",
  postconditionId: "error-4xx-5xx",
};

const SENTRY_SPAN_CTX = {
  packageName: "@sentry/node",
  postconditionId: "span-manual-finish-never-called",
};

// ──────────────────────────────────────────────────────────────────────────────
// record + serialize — recorded entries verbatim
// ──────────────────────────────────────────────────────────────────────────────

describe("DetectionTraceAccumulator — record + serialize", () => {
  it("captures a failed entry with its reason", () => {
    const acc = new DetectionTraceAccumulator(AXIOS_CTX);
    acc.record(MATCHER_IDS.TRY_CATCH_DIRECT, "failed", "no try around the call");

    const trace = acc.serialize();
    const entry = trace.find(
      (e) => e.matcher === MATCHER_IDS.TRY_CATCH_DIRECT,
    );

    expect(entry).toEqual({
      matcher: MATCHER_IDS.TRY_CATCH_DIRECT,
      status: "failed",
      reason: "no try around the call",
    });
  });

  it("captures a passed entry and strips reason (schema: reason only when failed)", () => {
    const acc = new DetectionTraceAccumulator(AXIOS_CTX);
    // Caller may erroneously pass a reason on a passed entry; the
    // accumulator drops it so the wire shape stays canonical.
    acc.record(
      MATCHER_IDS.PROMISE_CATCH_HANDLER,
      "passed",
      "this reason must be stripped",
    );

    const trace = acc.serialize();
    const entry = trace.find(
      (e) => e.matcher === MATCHER_IDS.PROMISE_CATCH_HANDLER,
    );

    expect(entry).toEqual({
      matcher: MATCHER_IDS.PROMISE_CATCH_HANDLER,
      status: "passed",
    });
    expect(entry).not.toHaveProperty("reason");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// serialize() — fills not_applicable for applicable-but-unrecorded matchers
// ──────────────────────────────────────────────────────────────────────────────

describe("DetectionTraceAccumulator — serialize() fills not_applicable", () => {
  it("emits not_applicable for every registered matcher that was never recorded", () => {
    const acc = new DetectionTraceAccumulator(AXIOS_CTX);
    // Record only one matcher; every other matcher in MATCHER_IDS must
    // appear in the trace as not_applicable so a downstream reader sees
    // the complete consideration set (WAVE-2B: predicate-gating was
    // removed from serialize() Pass 2; the predicate is now informational
    // only — the trace surfaces every registered matcher exactly once).
    acc.record(MATCHER_IDS.TRY_CATCH_DIRECT, "failed", "checked, no try");

    const trace = acc.serialize();

    // PROMISE_CATCH_HANDLER was NOT recorded, so it must be present as
    // not_applicable.
    const promise = trace.find(
      (e) => e.matcher === MATCHER_IDS.PROMISE_CATCH_HANDLER,
    );
    expect(promise).toBeDefined();
    expect(promise?.status).toBe("not_applicable");
    expect(promise).not.toHaveProperty("reason");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// serialize() — emits not_applicable for matchers whose predicate is false
// (WAVE-2B revision: trace surface is now complete; predicate is informational
// but no longer filters serialize().)
// ──────────────────────────────────────────────────────────────────────────────

describe("DetectionTraceAccumulator — serialize() surfaces non-applicable matchers", () => {
  it("emits not_applicable for matchers whose applicabilityPredicate is false (WAVE-2B: auditable trace)", () => {
    const acc = new DetectionTraceAccumulator(AXIOS_CTX);
    // record nothing — let serialize() walk the registry.
    const trace = acc.serialize();

    // FRAMEWORK_EXPRESS_ASYNC_ERRORS is postcondition-gated to express
    // async-middleware family; applicabilityPredicate returns false for
    // (axios, error-4xx-5xx). The predicate value is informational only —
    // the serialize() Pass 2 emits not_applicable for it regardless, so a
    // trace consumer can see "we considered this matcher and it didn't
    // apply here" (Wave 0 PH1-R2a acceptance criterion).
    expect(
      applicabilityPredicate(
        MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
        AXIOS_CTX,
      ),
    ).toBe(false);

    const entry = trace.find(
      (e) => e.matcher === MATCHER_IDS.FRAMEWORK_EXPRESS_ASYNC_ERRORS,
    );
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("not_applicable");
    expect(entry).not.toHaveProperty("reason");
  });

  it("Pitfall 7: TRY_CATCH_DIRECT emitted as not_applicable for sentry span-lifecycle when not recorded", () => {
    const acc = new DetectionTraceAccumulator(SENTRY_SPAN_CTX);
    // Sanity: the registry gates TRY_CATCH_DIRECT off for sentry span-life.
    expect(
      applicabilityPredicate(MATCHER_IDS.TRY_CATCH_DIRECT, SENTRY_SPAN_CTX),
    ).toBe(false);

    const trace = acc.serialize();
    const entry = trace.find(
      (e) => e.matcher === MATCHER_IDS.TRY_CATCH_DIRECT,
    );
    // The matcher is now surfaced as not_applicable (WAVE-2B trace
    // completeness). The PH1-R2b test in detection-trace.test.ts still
    // checks the value flips from "failed" (recorded by canonical OR-chain)
    // to "not_applicable" — that flip lands in Plan 01-07 (Wave 2e) by
    // skipping the record() call for sentry span-lifecycle contexts.
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("not_applicable");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// duplicate record() keeps the LAST value (deterministic contract)
// ──────────────────────────────────────────────────────────────────────────────

describe("DetectionTraceAccumulator — duplicate record() semantics", () => {
  it("keeps the LAST record() of the same matcherId", () => {
    const acc = new DetectionTraceAccumulator(AXIOS_CTX);
    acc.record(MATCHER_IDS.TRY_CATCH_DIRECT, "failed", "first attempt");
    acc.record(MATCHER_IDS.TRY_CATCH_DIRECT, "passed");

    const trace = acc.serialize();
    const tcEntries = trace.filter(
      (e) => e.matcher === MATCHER_IDS.TRY_CATCH_DIRECT,
    );

    expect(tcEntries.length).toBe(1);
    expect(tcEntries[0].status).toBe("passed");
    expect(tcEntries[0]).not.toHaveProperty("reason");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// serialize() is idempotent
// ──────────────────────────────────────────────────────────────────────────────

describe("DetectionTraceAccumulator — serialize() is idempotent", () => {
  it("returns deep-equal results on repeated serialize() calls", () => {
    const acc = new DetectionTraceAccumulator(AXIOS_CTX);
    acc.record(MATCHER_IDS.TRY_CATCH_DIRECT, "failed", "no try");
    acc.record(MATCHER_IDS.PROMISE_CATCH_HANDLER, "passed");

    const first = acc.serialize();
    const second = acc.serialize();

    expect(second).toEqual(first);
    // Wire shape stability: same ordering, same content. Distinct objects
    // (not the same reference) so consumers may mutate one without
    // affecting the next call — but content matches.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
