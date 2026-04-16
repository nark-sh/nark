import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs module before importing auth
vi.mock('fs');

// Import after mocking
import { getToken, isLoggedIn, getCredentials } from './auth.js';

const CREDENTIALS_PATH = path.join(os.homedir(), '.nark', 'credentials');

const VALID_CREDENTIALS = {
  token: 'file-token-abc123',
  email: 'user@example.com',
  orgName: 'test-org',
  plan: 'pro',
};

describe('auth - NARK_TOKEN env var lookup', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };
    delete process.env.NARK_TOKEN;
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns NARK_TOKEN value when env var is set (even if credentials file exists)', () => {
    process.env.NARK_TOKEN = 'env-token-xyz';
    // Mock credentials file also existing
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDENTIALS));

    expect(getToken()).toBe('env-token-xyz');
  });

  it('returns credentials file token when NARK_TOKEN is not set', () => {
    // No NARK_TOKEN in env
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDENTIALS));

    expect(getToken()).toBe('file-token-abc123');
  });

  it('returns null when neither NARK_TOKEN nor credentials file exist', () => {
    // No NARK_TOKEN in env
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getToken()).toBeNull();
  });

  it('isLoggedIn() returns true when NARK_TOKEN is set', () => {
    process.env.NARK_TOKEN = 'env-token-for-ci';
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(isLoggedIn()).toBe(true);
  });

  it('ignores empty string NARK_TOKEN (treats as unset)', () => {
    process.env.NARK_TOKEN = '';
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDENTIALS));

    // Should fall through to credentials file
    expect(getToken()).toBe('file-token-abc123');
  });

  it('ignores empty string NARK_TOKEN and returns null when no credentials file', () => {
    process.env.NARK_TOKEN = '';
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getToken()).toBeNull();
  });
});
