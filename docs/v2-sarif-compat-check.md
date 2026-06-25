# SARIF Writer Compatibility Check — Phase 01 Wave 0

**Verdict: SAFE.** The current SARIF writer can tolerate Wave 1's new optional
fields on `Violation` (`detectionTrace`, `conventionMatch`, and any future
additive surface) without code change.

## Verification

Source under review: `src/output/sarif-writer.ts:105-179` (commit `a3b332e`).

The writer body (`writeSarifOutput`) iterates each violation and reads ONLY
the following named properties from the `Violation` object:

| Field accessed         | Line(s)     | Used for                                  |
| ---------------------- | ----------- | ----------------------------------------- |
| `v.package`            | 109, 125    | composes `ruleId`                          |
| `v.contract_clause`    | 109, 125    | composes `ruleId`                          |
| `v.source_doc`         | 118         | `SarifRule.helpUri`                       |
| `v.description`        | 120, 135    | rule short description + result message    |
| `v.file`               | 127         | source path → SARIF `artifactLocation.uri` |
| `v.severity`           | 133         | mapped to SARIF `level`                    |
| `v.line`               | 144         | SARIF `region.startLine`                   |
| `v.column`             | 145         | SARIF `region.startColumn`                 |

No `Object.keys(v)`, no `for...in v`, no `JSON.stringify(v)` of the raw
violation, no spread (`...v`) into the SARIF result. Every output field is
explicitly composed from a named property. Unknown fields on `Violation`
are dropped silently.

The SARIF envelope itself (`SarifLog`, `SarifRun`, `SarifResult`, `SarifRule`)
is constructed with `as const` typing and inline object literals — there is no
codepath through which a new optional field on `Violation` can leak into the
emitted SARIF payload.

## Conclusion

Wave 1 may add `detectionTrace?:`, `conventionMatch?:`, and any other purely
additive optional fields to `Violation` (in `src/v2/types/index.ts` AND/OR
`src/types.ts`) without coordinating a same-PR change in `sarif-writer.ts`.
No allowlist tightening is required.

## What WOULD break this guarantee

The compatibility guarantee depends on the writer remaining
allowlist-shaped. Future changes that WOULD invalidate this note and require a
re-check:

- replacing the explicit field accesses with a spread / `Object.assign` /
  `JSON.stringify(v)` pattern;
- adding `properties: v` (SARIF supports per-result `properties` bag, but our
  writer does not currently use it; if added, that bag MUST be a typed subset,
  never the raw violation);
- adopting a SARIF strict-mode validator at output time that rejects unknown
  fields anywhere in the payload (we don't ship one today; if introduced,
  baseline the validator against a Phase 01 sample before merging).

## Wave 5 action item

None. The Wave 5 verification pass should run the existing SARIF output tests
(`src/v2/fixtures/sarif-output.test.ts`) after Wave 1's type expansion lands;
those tests cover empty, single, and dedupe-rule cases. If those pass, this
SAFE verdict carries forward.

## References

- Plan: `.planning/phases/01-.../01-01-PLAN.md` (Task 3)
- Phase research: `.planning/phases/01-.../01-RESEARCH.md`
- Writer source: `src/output/sarif-writer.ts`
- Existing writer tests: `src/v2/fixtures/sarif-output.test.ts`
