# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ioredfour is a Redis-based distributed lock (binary semaphore) library for Node.js, forked from redfour to use ioredis instead of node_redis. It provides atomic lock operations via Lua scripts with optional replication consistency guarantees. CommonJS, no build step, Node.js >= 20.

Known consumers: EmailEngine (`../emailengine`, `lib/account.js` and `lib/oauth2-apps.js`), which pins an exact version and is bundled into a `pkg` single-file binary, so the package must stay CommonJS and pure JavaScript.

## Commands

- **Test**: `npm test` (Node's built-in `node:test` runner, standalone Redis only)
- **Single test**: `node --test --test-force-exit --test-name-pattern="valid index" test/ioredfour-test.js`
- **Cluster tests**: `npm run test:cluster` (needs a Redis Cluster on localhost:7000-7002), `npm run test:all` for both
- **Coverage**: `npm run test:coverage` (c8)
- **Lint**: `npm run lint` (`npm run lint:fix` to autofix)
- **Format**: `npm run format` (prettier), `npm run format:check` to verify
- **Update dependencies**: `npm run update` (removes node_modules and the lockfile, runs ncu -u, reinstalls)

## Testing

Tests require a running Redis instance. Set `REDIS_STANDALONE_URL` or it defaults to `redis://localhost:6379/11`. `TEST_TARGET` (`standalone` default, `cluster`, `all`) picks which suites run; the others are skipped as a whole suite. Per-test timeouts (10 s standalone, 15 s cluster) are passed to each `it()` because a `describe()` timeout in `node:test` covers the whole suite.

The suite leaves some Redis connections open (several tests create clients they never close), so the scripts pass `--test-force-exit`; without it the run never exits. Keep it when invoking the runner by hand.

CI (`.github/workflows/test.yml`) runs lint, format check and tests on Node 20, 22 and 24 against a Redis service container. The cluster suite does not run in CI.

## Architecture

**lib/ioredfour.js** - Single `Lock` class (an `EventEmitter`) with public methods `acquireLock`, `releaseLock`, `extendLock`, `waitAcquireLock` and `close`. Supports both promise and callback APIs. It uses two Redis connections: one for commands and one for Pub/Sub. A caller-supplied client (`redis` or the `redisConnection` alias) is duplicated for the subscriber and left open by `close()`; connections built from a URL/options object or a `cluster` node list are owned and closed by `close()`. Connection errors are forwarded as `error` events only when someone listens.

**lib/scripts.js** - Three Lua scripts (acquire, extend, release) that run atomically in Redis. They are registered as custom commands under namespace-hashed names (`ior4_<hash>_<name>`, see `fn()`) to avoid collisions between namespaces. The Lua side validates the TTL too, so a lock key can never be created without an expiry.

Key design choices:

- Lock indices (incrementing counters) prevent stale holders from interfering (ABA problem)
- Pub/Sub release notifications let waiters wake up immediately; waiting is a hybrid of subscribe and polling. If the subscription is refused (e.g. an ACL user without channel permissions) `_pubsubRefused` is set and waiters fall back to polling
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
- Dev dependencies are pinned to exact versions. Runtime code stays CommonJS; reject ESM-only dependency upgrades in `.ncurc.js` with a reason.

**Before committing code changes**

1. `npm run format` and `npm run lint`
2. `npm test`
3. For non-trivial changes, consider `/simplify` and `/security-review`.

**After pushing**

- Check the workflow runs for the push (`gh run list --branch <branch>`) and report their status. If a run fails for an unrelated/infrastructure reason (checkout reporting "account suspended", HTTP 403, other auth errors), check <https://www.githubstatus.com/> for an active GitHub incident before assuming the change caused it.
