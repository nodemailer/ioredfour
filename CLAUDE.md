# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ioredfour is a Redis-based distributed lock (binary semaphore) library for Node.js, forked from redfour to use ioredis instead of node_redis. It provides atomic lock operations via Lua scripts with optional replication consistency guarantees.

## Commands

- **Format**: `npm run format` (prettier)
- **Lint**: `npm run lint` (eslint)
- **Lint + Test**: `npm test` (runs Grunt: eslint then mocha)
- **Update dependencies**: `npm run update` (removes node_modules, runs ncu -u, reinstalls)

There is no build step. There is no way to run a single test without modifying the Gruntfile.

## Releases

Releases are managed by the release-please GitHub Action. Never modify the `version` field in `package.json` or create git version tags manually — release-please handles both automatically based on conventional commit messages.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `chore:`). This is required because release-please uses commit messages to automate versioning and npm publishing.

## Architecture

**lib/ioredfour.js** — Single `Lock` class with four public methods: `acquireLock`, `releaseLock`, `extendLock`, `waitAcquireLock`. Uses dual Redis connections (one for commands, one for Pub/Sub). Supports both promise and callback APIs.

**lib/scripts.js** — Three Lua scripts (acquire, extend, release) that run atomically in Redis. These are registered as custom Redis commands with namespace-hashed names to avoid collisions.

Key design choices:

- Lock indices (incrementing counters) prevent stale holders from interfering (ABA problem)
- Pub/Sub notifications allow efficient waiting with hybrid polling/subscribe approach
- Optional `WAIT` command support for replication consistency across Redis replicas

## Testing

Tests require a running Redis instance. Set `REDIS_STANDALONE_URL` env var or it defaults to `redis://localhost:6379/11`. Tests use mocha/chai with a 10-second timeout.

## Code Style

- ESLint flat config (`eslint.config.js`) with eslint-config-nodemailer + prettier
- Prettier: 160 char width, 4 spaces, single quotes, no trailing commas
- `.ncurc.js` blocks ESM-only dependency upgrades (e.g., chai)
