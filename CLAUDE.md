# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ioredfour is a Redis-based distributed lock (binary semaphore) library for Node.js, forked from redfour to use ioredis instead of node_redis. It provides atomic lock operations via Lua scripts with optional replication consistency guarantees. Written in TypeScript under `src/` and published as a dual package: ES modules in `dist/esm/` and CommonJS in `dist/cjs/`, each with its own type declarations. `require('ioredfour')` returns the `Lock` class itself, the shape the JavaScript package had (`module.exports = Lock`), and `import Lock from 'ioredfour'` works from ES modules. Node.js >= 20.

Known consumers: EmailEngine (`../emailengine`, `lib/account.js` and `lib/oauth2-apps.js`, `require('ioredfour')` only), which pins an exact version and is bundled into a `pkg` single-file binary, so the CommonJS build must stay genuinely CommonJS.

The migration follows the one of `../nodemailer` and `../imapflow`; keep the build, lint and test setup in line with theirs.

## Platform constraints

EmailEngine ships as a `@yao-pkg/pkg` binary that snapshots a CommonJS module graph and cannot load ES modules, and its DigitalOcean one-click images update EmailEngine but never the Node.js under it. Two rules follow:

- **Node.js 20 is the minimum.** Code, tests and tooling must work on Node 20, 22 and 24 (`engines.node` is `>=20.0.0`). TypeScript `target: ES2022`, `lib: ES2023`, and `@types/node` stays on the 20.x line (`.ncurc.cjs`) so the compiler rejects APIs Node 20 lacks.
- **Everything that reaches runtime must be genuinely CommonJS-loadable.** The CommonJS build and every runtime dependency (ioredis and its tree) must load through `require()` with `--no-experimental-require-module`. A CommonJS entry that only wraps a dynamic `import()` of ESM code does not count. Node 22+ (and 20.19) load ES modules through `require()` by default, so a plain `npm test` stays green with an ESM-only dependency.
- **How to check:** `npm run test:cjs` builds, then runs `test/package/cjs-smoke.cjs` (plain JavaScript on purpose, tsx would transpile an ES module and hide the failure) with `NODE_OPTIONS=--no-experimental-require-module`: it requires the package and its deep imports by name and does a lock round trip against Redis. `npm run test:pkg` (`scripts/pkg-smoke.sh`) packs the package, installs the tarball into a scratch project, bundles the same smoke test into a `@yao-pkg/pkg` binary (the version EmailEngine's CI uses, `PKG_VERSION` to override) and runs it. CI runs the first on Node 22 and 24 and the second in its own job. Run both after any dependency or packaging change.
- pkg follows the `exports` map only for ES modules. For a CommonJS package it resolves deep requires such as `ioredfour/lib/scripts` by file path, finds nothing and warns; they still load in the binary because Node resolves them through `exports` at runtime, to files the entry point already pulled in. `test/package/package-test.ts` checks that the entry point reaches every module of `dist/cjs`, keep it that way (or ship real files at the `lib/` paths).
- **Pinning:** never add or upgrade to an ESM-only dependency, nor to one that needs a newer Node than 20. Hold the last compatible major in `.ncurc.cjs` (`reject` or `target`) with a comment giving the reason. Dev tooling has its own pins there: `typescript` stays on the 6.x line because typescript-eslint's peer range excludes 7.

## Commands

- **Build**: `npm run build` (`scripts/build.js`, also runs on install and before publish via `prepare`, and before every test script via the `pre*` scripts)
- **Test**: `npm test` (build, then Node's built-in `node:test` runner through tsx, standalone Redis and the package tests)
- **Single test**: `node --import tsx --test --test-force-exit --test-name-pattern="valid index" test/ioredfour-test.ts`
- **CommonJS check**: `npm run test:cjs`, **pkg binary check**: `npm run test:pkg` (see Platform constraints)
- **Cluster tests**: `npm run cluster:up && npm run test:cluster; npm run cluster:down` (see Testing), `npm run test:all` for both suites
- **Coverage**: `npm run test:coverage` (c8, both suites, so the cluster must be up; thresholds in `.c8rc.json` are 100%)
- **Mutation tests**: `TEST_TARGET=all npm run test:mutation` (slow, not in CI, see Testing)
- **Lint**: `npm run lint` (`tsc --noEmit` over `src/` and `test/`, then ESLint; `npm run lint:fix` to autofix), `npm run typecheck` for the type-check alone
- **Format**: `npm run format` (prettier), `npm run format:check` to verify
- **Update dependencies**: `npm run update` (removes node_modules and the lockfile, runs ncu -u, reinstalls)

## Testing

Tests are TypeScript (`test/*-test.ts`, `test/package/*-test.ts`), run with `node --import tsx --test`. They require a running Redis instance. Set `REDIS_STANDALONE_URL` or it defaults to `redis://localhost:6379/11`. `TEST_TARGET` (`standalone` default, `cluster`, `all`) picks which suites run; the others are skipped as a whole suite. Per-test timeouts (10 s standalone, 15 s cluster) are passed to each `it()` because a `describe()` timeout in `node:test` covers the whole suite. Shared settings and helpers live in `test/fixtures/redis.ts`.

The scripts pass `--test-force-exit` because several tests create clients they never close; without it the run never exits. Keep it when invoking the runner by hand.

- `test/ioredfour-test.ts` - the API, hardening cases (refused Pub/Sub, keyPrefix, TTL validation, close()), the replication paths and the cluster suite
- `test/lock-regression-test.ts` - one test per fixed bug, each verified to fail on the code before the fix. A new fix gets its regression test here
- `test/fuzz-test.ts` - seeded generated tests: TTL strings fed straight to the Lua scripts against a one-line oracle (a key without expiry fails it), and random operation sequences over several Lock instances compared with an in-memory model of the lock, checking every result and the state left in Redis after each step. `FUZZ_SEED` and `FUZZ_ITERATIONS` (`test/fixtures/fuzz.ts`) control a run; the default seed is fixed, a failure names its seed and case. Raise `FUZZ_ITERATIONS` for a soak run after touching the scripts or the result mapping
- `test/with-lock-test.ts` - `withLock`: release on success and on throw, `ELOCKNOTACQUIRED`, automatic extension and the `ELOCKLOST` abort, an extension in flight settling before the release, release failures, and a seeded test of random concurrent callers (some extending with a TTL shorter than their hold, some throwing) that must never overlap
- `test/contention-test.ts` - many waiters on separate connections compete for one lock: mutual exclusion, liveness through notifications and through the TTL of holders that never release, growing indexes
- `test/package/` - runs against the built `dist/`: module shapes of both builds and the deep imports through the exports map (`package-test.ts`), consumer programs type-checked against the shipped declarations under node16 ESM, node16 CommonJS and bundler resolution with `exactOptionalPropertyTypes`, and the stripped internals (`types-consumer-test.ts`), and the CommonJS smoke test (`cjs-smoke.cjs`, not part of `npm test`)
- `npm run test:mutation` (`scripts/mutation-test.js`) applies one-operator mutants to `src/ioredfour.ts` and `src/scripts.ts`, Lua included, in private copies of the repository, runs the suite against each, one Redis database per worker, and lists the mutants no test catches. Run it with the cluster up after larger changes and either add a test for a surviving mutant or confirm it is equivalent. `--file`, `--max` and `--survivors <json>` narrow a run

The cluster suite needs a Redis Cluster. `npm run cluster:up` (`scripts/redis-cluster.sh`) starts three masters with one replica each in one Docker container (image pinned to an exact tag in the script, container `ioredfour-cluster`) on `127.0.0.1:7100-7105`, announcing 127.0.0.1 so the slot map points at the published ports, and waits for `cluster_state:ok` and the replicas' first sync. The replicas let the `minReplications` tests see a write replicated, the only place the success path of `WAIT` runs. `npm run cluster:down` removes it. Nothing touches port 6379, and port 7000 is avoided because macOS runs the AirPlay receiver there. Point the tests at another cluster with `REDIS_CLUSTER_NODES=host:port,host:port,...`, or move the script's ports with `REDIS_CLUSTER_PORT` (first of six).

CI (`.github/workflows/test.yml`): `test` runs lint, format check and `npm test` against a Redis service container on Node 20, 22, 24 and latest, plus `npm run test:cjs` on everything but Node 20; `cluster` starts the cluster with the same script and runs `npm run test:cluster` on the same versions; `coverage` runs `npm run test:coverage` on Node 24 with both; `pkg` runs `npm run test:pkg` on Node 24.

## Architecture

**src/ioredfour.ts** - Single `Lock` class (an `EventEmitter`, the module's only runtime export, `export default`) with public methods `acquireLock`, `releaseLock`, `extendLock`, `waitAcquireLock`, `withLock` (promise only) and `close`, plus the exported option and result types. The `LockError` class `withLock` throws is a non-enumerable static (`Lock.LockError`) so the module keeps the default export as its only runtime export and `Object.keys(require('ioredfour'))` stays empty; its type is exported type-only. Supports both promise and callback APIs (overloads; the callback form is chosen by argument count, as before). It uses two Redis connections: one for commands and one for Pub/Sub. A caller-supplied client (`redis` or the `redisConnection` alias) is duplicated for the subscriber and left open by `close()`; connections built from a URL/options object or a `cluster` node list are owned and closed by `close()`. Connection errors are forwarded as `error` events only when someone listens. Underscore members, `fn()` and the other helpers are `@internal`: they exist at runtime (the tests use them) but are stripped from the declarations.

**src/scripts.ts** - Three Lua scripts (acquire, extend, release) that run atomically in Redis, and `MAX_TTL`. They are registered as custom commands under namespace-hashed names (`ior4_<hash>_<name>`, see `fn()`) to avoid collisions between namespaces. The Lua side validates the TTL too, as a string of at most 15 decimal digits, before any write, and passes that string to PEXPIRE, so a lock key can never be created without an expiry. ioredis parses integer replies near `Number.MAX_SAFE_INTEGER` inexactly, which is why `MAX_TTL` is 15 digits.

**scripts/build.js** - Runs `tsc` with `tsconfig.esm.json` (`module: nodenext`) and `tsconfig.cjs.json` (`module: commonjs`), writes a `package.json` with the module format into each output directory, and rewrites the CommonJS output of default-export modules so `require()` returns the class itself, with a non-enumerable `.default` alias for transpiled default imports. A module with a default export must have no other runtime export (type exports are fine), the build fails otherwise. `package.json` `exports` maps `.`, `./lib/ioredfour(.js)` and `./lib/scripts(.js)` (the files of the JavaScript package) to both builds; `src/`, `test/` and `scripts/` are not published.

Source rules (as in nodemailer and imapflow): every file compiles both ways, so no `import.meta`, `require`, `__dirname`, top-level `await` or JSON imports in `src/`; `erasableSyntaxOnly` (no enums, namespaces with code, parameter properties); every optional property of a public interface is declared `| undefined` for `exactOptionalPropertyTypes` consumers; relative imports carry `.js`; builtins use the `node:` prefix; ioredis is imported by name (`import { Redis, Cluster } from 'ioredis'`). `src/` is also linted with the type-aware rules; a promise deliberately left unawaited is marked with `void`.

Key design choices:

- Lock indices (incrementing counters) prevent stale holders from interfering (ABA problem)
- Pub/Sub release notifications let waiters wake up immediately; waiting is a hybrid of subscribe and polling. Notifications are not queued, so waiters also retry when the subscription first becomes active and every time the subscriber reconnects. If the subscription is refused (e.g. an ACL user without channel permissions) `_pubsubRefused` is set and waiters fall back to polling
- Timer delays are capped at 2^31-1 ms (Node fires longer ones after 1 ms): the retry delay is clamped and a longer `waitTtl` is split into several timers
- Cluster mode uses sharded Pub/Sub (`SSUBSCRIBE`/`SPUBLISH`, Redis 7+) with a hash-tagged release channel so it maps to the same slot as the lock keys
- Optional `WAIT`-based replication check (`minReplications`, `replicationTimeout`); a lock that fails it is released and reported with `replicationFailure: true`. The TTL must be at least 1.5x `replicationTimeout`

## Releases

Releases are managed by the release-please GitHub Action (`.github/workflows/release.yaml`), which also publishes to npm with provenance. Never modify the `version` field in `package.json` or create git version tags manually.

## Conventions

These mirror the conventions used across Postal Systems projects (see `../emailengine`).

**Git commits**

- Use Conventional Commits: `fix:` (patch release), `feat:` (minor release), and `chore:`/`build:`/`docs:`/`ci:`/`style:`/`refactor:`/`test:` for changes that should not trigger a release. release-please derives the version and changelog from these prefixes.
- Do **not** list Claude or any AI assistant as a co-author / co-contributor in commit messages or PR descriptions (no `Co-Authored-By` trailer).
- Append `[skip ci]` to commits that do not change runtime behavior (docs, comments, CI/workflow tweaks, formatting) to avoid spending CI minutes. Exception: never add it to a `fix:` or `feat:` commit, those must run so the release workflow triggers. GitHub reads the marker off the HEAD commit of a push, so when a push mixes the two, the release-triggering commit has to be last.

**Code & docs style**

- No emojis anywhere in code or documentation, printable ASCII only.
- Use a single hyphen-minus (`-`) as a dash in user-facing strings and docs. Never use double hyphens (`--`), em dashes, or en dashes.
- Dev dependencies are pinned to exact versions. The CommonJS build stays genuinely CommonJS (see Platform constraints).

**Before committing code changes**

1. `npm run format` and `npm run lint`
2. `npm test`, and with the cluster up `npm run test:coverage` for changes to `src/`
3. For non-trivial changes, consider `/simplify` and `/security-review`.

**After pushing**

- Check the workflow runs for the push (`gh run list --branch <branch>`) and report their status. If a run fails for an unrelated/infrastructure reason (checkout reporting "account suspended", HTTP 403, other auth errors), check <https://www.githubstatus.com/> for an active GitHub incident before assuming the change caused it.
