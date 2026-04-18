/**
 * Ground-truth tests for typescript compiler API contract
 *
 * Depth pass 2026-04-18 (deepen-stream-1 pass 8): 9 new functions contracted.
 * New postconditions have no scanner detection rules yet — all queued in upgrade-concerns.json
 * (concern-20260418-typescript-deepen-1 through -5).
 *
 * This file is a placeholder — actual ground-truth tests will be added once
 * scanner detection rules are implemented via bc-scanner-upgrade.
 *
 * Functions contracted this pass:
 *   - transpileModule: diagnostics-not-checked, custom-transformer-throws
 *   - program.emit: emit-skipped-not-checked, operation-canceled
 *   - program.getSemanticDiagnostics: not-checked-before-emit, canceled
 *   - readConfigFile: error-not-checked
 *   - parseJsonConfigFileContent: errors-not-checked
 *   - createSourceFile: parse-errors-not-checked
 *   - LanguageService.getSyntacticDiagnostics: file-not-found-throws
 *   - LanguageService.getSemanticDiagnostics: file-not-found-throws
 *   - getPreEmitDiagnostics: not-called-before-emit, operation-canceled
 *   - createProgram (new postcondition): string-option-throws
 */

import { describe, it } from 'vitest';

describe('typescript: ground-truth fixture', () => {
  it('placeholder — detection rules pending in upgrade-concerns.json', () => {
    // All new postconditions from the 2026-04-18 depth pass have no scanner rules yet.
    // Scanner concerns queued: concern-20260418-typescript-deepen-1 through -5
    // This test will be replaced with real ground-truth assertions once
    // bc-scanner-upgrade implements the detection rules.
  });
});
