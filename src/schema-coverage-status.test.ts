/**
 * Tests for the coverage_status schema upgrade (introduced for nark v3).
 *
 * Schema rules:
 *  - coverage_status absent or "covered": evidence_quality + non-empty functions required
 *  - coverage_status === "no-async-contract": coverage_rationale + researched_at required;
 *    functions may be empty or absent; evidence_quality not required
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import AjvModule from 'ajv';

const Ajv = (AjvModule as any).default || AjvModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'nark-corpus', 'schema', 'contract.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function baseProfile(): any {
  return {
    package: 'test-pkg',
    semver: '>=1.0.0',
    contract_version: '1.0.0',
    maintainer: 'test',
    last_verified: '2026-06-10',
    evidence_quality: 'confirmed',
    functions: [
      {
        name: 'doThing',
        import_path: 'test-pkg',
        description: 'does a thing',
        postconditions: [
          {
            id: 'p1',
            condition: 'on failure throws Error',
            required_handling: 'wrap in try/catch',
            sources: ['https://example.com/p1'],
            severity: 'error',
          },
        ],
      },
    ],
  };
}

describe('coverage_status schema', () => {
  describe('covered profiles (default state)', () => {
    it('accepts profile without coverage_status field (legacy behavior)', () => {
      const profile = baseProfile();
      expect(validate(profile)).toBe(true);
    });

    it('accepts profile with explicit coverage_status: covered', () => {
      const profile = { ...baseProfile(), coverage_status: 'covered' };
      expect(validate(profile)).toBe(true);
    });

    it('rejects covered profile missing functions', () => {
      const profile = baseProfile();
      delete profile.functions;
      expect(validate(profile)).toBe(false);
    });

    it('rejects covered profile with empty functions array', () => {
      const profile = { ...baseProfile(), functions: [] };
      expect(validate(profile)).toBe(false);
    });

    it('rejects covered profile missing evidence_quality', () => {
      const profile = baseProfile();
      delete profile.evidence_quality;
      expect(validate(profile)).toBe(false);
    });
  });

  describe('no-async-contract profiles (stub state)', () => {
    function stubProfile(): any {
      return {
        package: 'lucide-react',
        semver: '>=1.0.0',
        contract_version: '1.0.0',
        maintainer: 'test',
        last_verified: '2026-06-10',
        coverage_status: 'no-async-contract',
        researched_at: '2026-06-10',
        coverage_rationale:
          'Pure SVG icon component library. All exports are React components with no async I/O, no thrown errors.',
      };
    }

    it('accepts minimal stub profile with no functions field', () => {
      expect(validate(stubProfile())).toBe(true);
    });

    it('accepts stub profile with empty functions array', () => {
      const profile = { ...stubProfile(), functions: [] };
      expect(validate(profile)).toBe(true);
    });

    it('accepts stub profile without evidence_quality', () => {
      const profile = stubProfile();
      expect(profile.evidence_quality).toBeUndefined();
      expect(validate(profile)).toBe(true);
    });

    it('rejects stub profile missing coverage_rationale', () => {
      const profile = stubProfile();
      delete profile.coverage_rationale;
      expect(validate(profile)).toBe(false);
    });

    it('rejects stub profile missing researched_at', () => {
      const profile = stubProfile();
      delete profile.researched_at;
      expect(validate(profile)).toBe(false);
    });

    it('rejects researched_at with malformed date', () => {
      const profile = { ...stubProfile(), researched_at: '06-10-2026' };
      expect(validate(profile)).toBe(false);
    });
  });

  describe('invalid coverage_status values', () => {
    it('rejects unknown coverage_status enum value', () => {
      const profile = { ...baseProfile(), coverage_status: 'partial-coverage' };
      expect(validate(profile)).toBe(false);
    });
  });
});
