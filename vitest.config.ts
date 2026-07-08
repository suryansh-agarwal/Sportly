import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

// lib/supabase.ts reads process.env.EXPO_PUBLIC_SUPABASE_* at import time and
// throws if it's missing. Vite only exposes .env values via import.meta.env
// by default, so load them into process.env for the test run too.
Object.assign(process.env, loadEnv('test', process.cwd(), ''));

export default defineConfig({
  test: { include: ['lib/**/*.test.ts'] },
  resolve: {
    alias: {
      // These packages pull in `react-native` (Flow syntax), which Vitest's
      // Node environment can't parse. Hooks under test only exercise pure
      // logic, so the real storage/polyfill implementations are never
      // needed — swap in no-op stubs for the test run only.
      '@react-native-async-storage/async-storage': fileURLToPath(
        new URL('./test/mocks/async-storage.ts', import.meta.url)
      ),
      'react-native-url-polyfill/auto': fileURLToPath(
        new URL('./test/mocks/url-polyfill.ts', import.meta.url)
      ),
    },
  },
});
