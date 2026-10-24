import { defineConfig, type Plugin } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin],
  cacheDir: '/private/tmp/claude-501/-Users-gavinzhou-Desktop-calhacks/c875d98c-7a47-427a-9e39-fe74fb7781b5/scratchpad/review-redteam/ts/.vitecache',
  test: {
    environment: 'node',
    include: ['test/redteam*.test.ts'],
  },
});
