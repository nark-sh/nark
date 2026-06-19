import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default vitest hookTimeout is 10s — too short for ground-truth tests
    // that spin up nark scanner + corpus loader in beforeAll hooks.
    // Without this, tests like undici/openid-client/gray-matter silently
    // fail their hooks and no-op their assertions, degrading scanner-stream
    // verification signal across the pipeline.
    hookTimeout: 60000,
    testTimeout: 30000,
  },
});
