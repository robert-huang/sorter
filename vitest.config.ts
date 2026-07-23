import { defineConfig, mergeConfig, type UserConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig(async (env) => {
  const base =
    typeof viteConfig === 'function'
      ? await viteConfig({ ...env, mode: env.mode ?? 'test', command: 'serve' })
      : viteConfig;

  return mergeConfig(base as UserConfig, {
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    },
  });
});
