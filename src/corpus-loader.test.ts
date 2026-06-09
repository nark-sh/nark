/**
 * Tests for version-aware profile selection (selectContractForVersion).
 *
 * Covers:
 *  - single profile per package matches its installed version
 *  - two non-overlapping profiles → correct one selected by installed version
 *  - no profile matches → returns undefined
 *  - wildcard semver "*" matches every installed version
 *  - missing semver field treated as wildcard
 *  - missing installed version falls back to the most-specific profile
 *  - specific range wins over wildcard when both could apply
 */

import { describe, it, expect } from 'vitest';
import { selectContractForVersion } from './corpus-loader.js';
import type { PackageContract } from './types.js';

function makeContract(pkg: string, range: string | undefined, version = '1.0.0'): PackageContract {
  return {
    package: pkg,
    semver: range as string, // allow undefined for wildcard test
    contract_version: version,
    maintainer: 'test',
    last_verified: '2026-06-09',
    functions: [],
  };
}

describe('selectContractForVersion', () => {
  it('returns the only profile when one profile matches the installed version', () => {
    const profile = makeContract('firebase-admin', '>=11.0.0 <14.0.0', '1.0.0');
    const map = new Map([['firebase-admin', [profile]]]);

    const result = selectContractForVersion('firebase-admin', '12.5.0', map);

    expect(result).toBe(profile);
  });

  it('picks the version-matching profile when two non-overlapping profiles exist', () => {
    const v11to13 = makeContract('firebase-admin', '>=11.0.0 <14.0.0', '1.0.0');
    const v14plus = makeContract('firebase-admin', '>=14.0.0', '2.0.0');
    const map = new Map([['firebase-admin', [v14plus, v11to13]]]); // loader sorts; order shouldn't matter for correctness

    const v12 = selectContractForVersion('firebase-admin', '12.5.0', map);
    const v15 = selectContractForVersion('firebase-admin', '15.0.0', map);

    expect(v12).toBe(v11to13);
    expect(v15).toBe(v14plus);
  });

  it('returns undefined when no profile matches the installed version', () => {
    const v11to13 = makeContract('firebase-admin', '>=11.0.0 <14.0.0', '1.0.0');
    const v14plus = makeContract('firebase-admin', '>=14.0.0', '2.0.0');
    const map = new Map([['firebase-admin', [v14plus, v11to13]]]);

    const result = selectContractForVersion('firebase-admin', '9.0.0', map);

    expect(result).toBeUndefined();
  });

  it('returns undefined when the package is not in the corpus', () => {
    const map = new Map<string, PackageContract[]>();

    const result = selectContractForVersion('not-in-corpus', '1.0.0', map);

    expect(result).toBeUndefined();
  });

  it('matches any installed version when semver is the wildcard "*"', () => {
    const wildcard = makeContract('lodash', '*', '1.0.0');
    const map = new Map([['lodash', [wildcard]]]);

    expect(selectContractForVersion('lodash', '0.1.0', map)).toBe(wildcard);
    expect(selectContractForVersion('lodash', '4.17.21', map)).toBe(wildcard);
    expect(selectContractForVersion('lodash', '99.99.99', map)).toBe(wildcard);
  });

  it('treats missing semver field as a wildcard (backward compat)', () => {
    const noSemver = makeContract('legacy', undefined, '1.0.0');
    const map = new Map([['legacy', [noSemver]]]);

    expect(selectContractForVersion('legacy', '1.0.0', map)).toBe(noSemver);
    expect(selectContractForVersion('legacy', '17.0.0', map)).toBe(noSemver);
  });

  it('prefers a specific range over a wildcard when both could apply', () => {
    const wildcard = makeContract('axios', '*', '1.0.0');
    const v1 = makeContract('axios', '>=1.0.0 <2.0.0', '2.0.0');
    const map = new Map([['axios', [v1, wildcard]]]); // specific first per loader sort

    const result = selectContractForVersion('axios', '1.5.0', map);

    expect(result).toBe(v1);
  });

  it('falls back to the wildcard when no specific range matches', () => {
    const wildcard = makeContract('axios', '*', '1.0.0');
    const v2 = makeContract('axios', '>=2.0.0', '2.0.0');
    const map = new Map([['axios', [v2, wildcard]]]);

    const result = selectContractForVersion('axios', '1.5.0', map);

    expect(result).toBe(wildcard);
  });

  it('handles installed versions with v-prefix and other valid semver-coercible forms', () => {
    const v1 = makeContract('axios', '>=1.0.0 <2.0.0', '1.0.0');
    const map = new Map([['axios', [v1]]]);

    expect(selectContractForVersion('axios', 'v1.5.0', map)).toBe(v1);
    expect(selectContractForVersion('axios', '1.5', map)).toBe(v1);
  });

  it('returns the most-specific profile when installed version is undefined', () => {
    const v1 = makeContract('axios', '>=1.0.0 <2.0.0', '1.0.0');
    const wildcard = makeContract('axios', '*', '0.0.0');
    const map = new Map([['axios', [v1, wildcard]]]);

    const result = selectContractForVersion('axios', undefined, map);

    expect(result).toBe(v1);
  });
});
