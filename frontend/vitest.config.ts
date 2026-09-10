import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Test config for the focused frontend tests (MM4).
 *
 * The frontend had no test runner at all, so this is the smallest one that can
 * execute the checks the work items ask for. It runs in a NODE environment, not
 * jsdom: every test here exercises a pure decision function — which module a
 * route belongs to, whether a tenant may see it, whether an organisation slug is
 * usable — and none of them render a component. Adding jsdom and a React
 * testing library to assert on a decision table would be more machinery for a
 * weaker test.
 *
 * The preflight in scripts/ is deliberately NOT run here: it is dependency-free
 * and runs under `node --test`, so it stays usable in a checkout where npm
 * install has not been run.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
