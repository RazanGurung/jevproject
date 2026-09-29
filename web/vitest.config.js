import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A few suites do a heavy one-time dynamic import of the full
    // trading-service module graph (trading-service.test.js). Under full
    // parallel worker contention that transform can exceed Vitest's 5s default
    // and flake. Keep a generous timeout as the default for every invocation.
    testTimeout: 15000,
    hookTimeout: 15000,
    // Node 26's experimental localStorage is inert without --localstorage-file
    // and can leave jsdom window.localStorage undefined. vitest.setup.js
    // installs an in-memory Storage polyfill. Keep fileParallelism off so
    // suites that still touch real storage APIs stay serial.
    fileParallelism: false,
    setupFiles: ['./vitest.setup.js'],
  },
});
