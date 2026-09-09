#!/usr/bin/env node
/**
 * Lint only the backend files this working tree has changed (MM2-06).
 *
 * `npm run lint` covers everything and currently reports a small pre-existing
 * baseline in files nobody is touching. That makes it useless as a gate: a run
 * that is red before you start cannot tell you that YOU broke something. This
 * lints exactly the files in your diff, so a clean run means your change is
 * clean — which is the check worth putting in front of a commit.
 *
 * Compares against HEAD by default (staged, unstaged and untracked alike). Pass
 * a ref to compare against something else:  node scripts/lint-changed.mjs main
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'HEAD';

const git = (args) =>
  execFileSync('git', args, { cwd: backendDir, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

let files;
try {
  files = [
    // Tracked changes against the base ref, plus anything not yet added.
    ...git(['diff', '--name-only', '--diff-filter=ACMR', base, '--', 'src', 'test', 'scripts', 'prisma']),
    ...git(['ls-files', '--others', '--exclude-standard', '--', 'src', 'test', 'scripts', 'prisma']),
  ];
} catch (error) {
  console.error(`Could not list changed files (${error.message}). Is this a git checkout?`);
  process.exit(2);
}

// git reports paths from the repository root; this script runs from backend/.
const lintable = [...new Set(files)]
  .filter((f) => /\.(ts|mjs|js)$/.test(f))
  .map((f) => resolve(backendDir, f.replace(/^backend\//, '')))
  .filter((f) => existsSync(f));

if (!lintable.length) {
  console.log('No changed backend files to lint.');
  process.exit(0);
}

console.log(`Linting ${lintable.length} changed file(s)…`);

// The binary directly, run by this same node — not `npx`. Node refuses to spawn
// a Windows `.cmd` without a shell, and going through a shell would need the
// file list quoted for two different ones.
const eslintBin = resolve(backendDir, 'node_modules/eslint/bin/eslint.js');
if (!existsSync(eslintBin)) {
  console.error('eslint is not installed. Run `npm install` in backend/ first.');
  process.exit(2);
}

const result = spawnSync(process.execPath, [eslintBin, ...lintable], {
  cwd: backendDir,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
