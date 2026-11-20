import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * MM4-02 — the Docker image's backend target must be an explicit build input.
 *
 * next.config.ts resolves the `/_api` rewrite while `next build` runs and freezes
 * the result into routes-manifest.json, so a container's proxy target is decided
 * at BUILD time and cannot be changed by the runtime environment. Before this
 * item the Dockerfile named no target at all, so every image inherited
 * next.config.ts's hardcoded production origin — the same build-time baking that
 * sent three local sign-in attempts to the live backend during Phase 3.
 *
 * Note the shape of the fix, because it is not the obvious one. Adding
 * `ARG BACKEND_ORIGIN` alone does NOT produce a loud failure: an unset ARG
 * expands to the empty string, `ENV` sets it anyway, and next.config.ts's
 * `process.env.BACKEND_ORIGIN ?? "<production>"` does not fall back on "" — the
 * image would rewrite /_api to itself and 404 every API call at runtime instead.
 * So the ARG is paired with a build-time guard that fails the build outright,
 * and these tests assert the guard, not just the ARG.
 *
 * Static assertions on purpose: `docker build` would pull node:22-slim and run
 * npm ci against a registry, which this phase must not do. Everything these
 * checks care about is textual and ordered, and the file is 60 lines.
 */

const DOCKERFILE = readFileSync(
  fileURLToPath(new URL('../Dockerfile', import.meta.url)),
  'utf8',
);
const lines = DOCKERFILE.split(/\r?\n/);

/** Index of the first line whose instruction matches, ignoring comments. */
const lineOf = (re) => lines.findIndex((l) => !l.trimStart().startsWith('#') && re.test(l));

test('BACKEND_ORIGIN is declared as a build ARG', () => {
  assert.ok(lineOf(/^\s*ARG\s+BACKEND_ORIGIN\s*$/) !== -1, 'expected a bare `ARG BACKEND_ORIGIN`');
});

test('the ARG carries no default value', () => {
  // `ARG BACKEND_ORIGIN=https://…` would reintroduce exactly the silent
  // fallback this item exists to remove.
  assert.equal(
    lines.some((l) => /^\s*ARG\s+BACKEND_ORIGIN\s*=/.test(l)),
    false,
    'ARG BACKEND_ORIGIN must not have a default',
  );
});

test('the ARG is exported as ENV so next.config.ts can read it', () => {
  assert.ok(
    lineOf(/^\s*ENV\s+BACKEND_ORIGIN=\$BACKEND_ORIGIN\s*$/) !== -1,
    'expected `ENV BACKEND_ORIGIN=$BACKEND_ORIGIN`',
  );
});

test('a missing build arg fails the build instead of baking an empty origin', () => {
  // The ARG alone is not enough. Unset, it expands to "", ENV sets it anyway,
  // and next.config.ts's `?? "<production>"` does not fire on an empty string —
  // the image would build clean and rewrite /_api to itself. This guard is what
  // turns that into a build failure.
  const guard = lineOf(/^\s*RUN\s+test\s+-n\s+"\$BACKEND_ORIGIN"/);
  assert.ok(guard !== -1, 'expected a `RUN test -n "$BACKEND_ORIGIN" || …` guard');
  const build = lineOf(/^\s*RUN\s+npm run build\s*$/);
  assert.ok(guard < build, 'the guard must run before the build, not after it');
});

test('the guard names the fix rather than only failing', () => {
  const block = DOCKERFILE.slice(DOCKERFILE.indexOf('RUN test -n "$BACKEND_ORIGIN"'));
  assert.match(block.slice(0, 400), /--build-arg BACKEND_ORIGIN=/);
});

test('the comment describes what the code actually does', () => {
  // The first version of this comment claimed an image without the arg would
  // "silently inherit next.config.ts's production fallback". It would not — the
  // empty string defeats `??`. A comment that predicts the wrong failure sends
  // the next maintainer to debug the wrong system.
  const comments = lines.filter((l) => l.trimStart().startsWith('#')).join('\n');
  assert.equal(
    /inherits? next\.config\.ts's production fallback/.test(comments),
    false,
    'the Dockerfile must not claim a fallback that the empty string prevents',
  );
  assert.match(comments, /EMPTY STRING/, 'the real mechanism should be stated');
});

test('ARG, then ENV, then the build — in that order', () => {
  const arg = lineOf(/^\s*ARG\s+BACKEND_ORIGIN\s*$/);
  const env = lineOf(/^\s*ENV\s+BACKEND_ORIGIN=/);
  const build = lineOf(/^\s*RUN\s+npm run build\s*$/);
  assert.ok(build !== -1, 'expected `RUN npm run build`');
  assert.ok(arg < env, `ARG (line ${arg + 1}) must precede ENV (line ${env + 1})`);
  assert.ok(
    env < build,
    `ENV (line ${env + 1}) must precede the build (line ${build + 1}) — Next reads it during the build`,
  );
});

test('the same ordering still holds for NEXT_PUBLIC_API_URL', () => {
  const env = lineOf(/^\s*ENV\s+NEXT_PUBLIC_API_URL=/);
  const build = lineOf(/^\s*RUN\s+npm run build\s*$/);
  assert.ok(lineOf(/^\s*ARG\s+NEXT_PUBLIC_API_URL\s*$/) !== -1);
  assert.ok(env < build, 'NEXT_PUBLIC_API_URL must be set before the build too');
});

test('both build-time targets are set in the build stage, not the runtime stage', () => {
  const runtimeStage = lineOf(/^\s*FROM\s+.*\s+AS\s+runtime\s*$/);
  assert.ok(runtimeStage !== -1, 'expected a runtime stage');
  for (const key of ['BACKEND_ORIGIN', 'NEXT_PUBLIC_API_URL']) {
    const env = lineOf(new RegExp(`^\\s*ENV\\s+${key}=`));
    assert.ok(
      env < runtimeStage,
      `${key} is baked at build time; setting it in the runtime stage does nothing`,
    );
  }
});

test('no production or Railway host is hardcoded anywhere in the Dockerfile', () => {
  // Instructions only: the comments deliberately explain the production case in
  // prose, and an example there is documentation, not a baked value.
  const instructions = lines.filter((l) => l.trim() && !l.trimStart().startsWith('#')).join('\n');
  for (const forbidden of [/railway\.app/i, /vercel\.app/i, /eclatdiamonds/i, /caratsense\.in/i]) {
    assert.equal(forbidden.test(instructions), false, `hardcoded host: ${forbidden}`);
  }
});

test('no ARG or ENV carries a URL as its value', () => {
  // Narrower than banning URLs outright, which would misfire on a legitimate
  // registry, package source or healthcheck. What MM4-02 cares about is a
  // target smuggled in as a default.
  for (const line of lines) {
    if (line.trimStart().startsWith('#')) continue;
    if (!/^\s*(ARG|ENV)\s/.test(line)) continue;
    assert.equal(
      /https?:\/\//.test(line),
      false,
      `a build-time target must come from --build-arg, not from the file: ${line.trim()}`,
    );
  }
});

test('no .env file is copied into the image', () => {
  assert.equal(
    lines.some((l) => /^\s*COPY\b.*\.env/.test(l)),
    false,
    'a COPY naming a .env file would put real values in an image layer',
  );
  const ignore = readFileSync(
    fileURLToPath(new URL('../.dockerignore', import.meta.url)),
    'utf8',
  ).split(/\r?\n/).map((l) => l.trim());
  // `COPY . .` is only safe because .dockerignore excludes them.
  assert.ok(ignore.includes('.env'), '.dockerignore must exclude .env');
  assert.ok(ignore.includes('.env.*'), '.dockerignore must exclude .env.*');
});

test('the build environment is never printed', () => {
  const instructions = lines.filter((l) => !l.trimStart().startsWith('#'));
  assert.equal(
    instructions.some((l) => /^\s*RUN\b.*\b(env|printenv|set)\b\s*$/.test(l)),
    false,
    'dumping the environment into build logs would leak the targets and any secrets alongside them',
  );
});
