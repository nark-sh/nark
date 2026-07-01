/**
 * Mutation operator interface.
 *
 * Each operator implements a single, well-defined AST transform (per spec
 * work-packages/accuracy-roadmap/0004-mutation-harness-spec.md §2).
 *
 * The runner walks fixture seeds, applies operators whose `seedType` matches
 * the seed's filename, compares nark output before/after, and classifies the
 * result against `expected`.
 */

export type SeedType = 'proper' | 'missing' | 'instance' | 'any';

export type MutationKind = 'fp-induction' | 'tp-suppression' | 'neutral';

export type ExpectedDelta =
  | 'violation-added'   // scan should produce MORE violations after mutation
  | 'violation-removed' // scan should produce FEWER violations after mutation
  | 'unchanged';        // scan output should be identical (up to line drift)

export interface MutationOperator {
  /** Short kebab-case name, e.g. "strip-try-catch". Used in run output + fixture snapshot dir. */
  name: string;

  /** Category — determines which failure classification we care about. */
  kind: MutationKind;

  /** Which seed filenames this operator applies to. */
  seedType: SeedType;

  /** What the scanner should do after the mutation applies. */
  expected: ExpectedDelta;

  /**
   * Attempt to mutate `sourceCode`. Return the mutated string, or `null` if
   * the operator is not applicable to this particular seed (e.g. strip-try-catch
   * on a file with no try/catch, or add-void-operator on a file with no eligible
   * call expression). Null returns are `skip`-classified by the runner.
   */
  apply(sourceCode: string, filePath: string): string | null;
}
