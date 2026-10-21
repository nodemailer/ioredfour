'use strict';

// CommonJS smoke test for the built package, run by `npm run test:cjs` as plain Node with
// NODE_OPTIONS=--no-experimental-require-module. EmailEngine bundles ioredfour into a
// @yao-pkg/pkg binary that can only load a CommonJS module graph, and Node 22+ enables
// require(esm) by default, which would hide an ES module reached through require(). With the
// flag set, such a module throws ERR_REQUIRE_ESM here instead of in the binary. Kept as plain
// JavaScript on purpose: running it through tsx would let its loader transpile an ES module to
// CommonJS and mask exactly the failure this guards against.
//
// Also used by scripts/pkg-smoke.sh as the entry point of a pkg binary, so it only requires the
// package by name and finishes by printing a line the script checks for.

const assert = require('node:assert/strict');

const Lock = require('ioredfour');
const { acquireScript } = require('ioredfour/lib/scripts');

const REDIS_URL = process.env.REDIS_STANDALONE_URL || 'redis://localhost:6379/11';

async function run() {
    assert.strictEqual(typeof Lock, 'function');
    assert.strictEqual(require('ioredfour/lib/ioredfour'), Lock);
    assert.strictEqual(typeof acquireScript(), 'string');

    // The way EmailEngine uses it: a shared connection, then acquire, wait and release
    const Redis = require('ioredis');
    const redis = new Redis(REDIS_URL);
    const lock = new Lock({ redis, namespace: 'cjs-smoke' });
    const id = 'smoke:' + process.pid + ':' + Date.now();
    try {
        const first = await lock.acquireLock(id, 10 * 1000);
        assert.strictEqual(first.success, true);
        setTimeout(() => lock.releaseLock(first), 100);
        const second = await lock.waitAcquireLock(id, 10 * 1000, 5 * 1000);
        assert.strictEqual(second.success, true);
        assert.ok(second.index > first.index);
        const released = await lock.releaseLock(second);
        assert.strictEqual(released.result, 'released');

        const value = await lock.withLock(id, 10 * 1000, 5 * 1000, held => held.index, { extend: true });
        assert.ok(value > second.index);
        const holder = await lock.acquireLock(id, 10 * 1000);
        await assert.rejects(
            lock.withLock(id, 10 * 1000, 50, () => 1),
            err => err instanceof Lock.LockError && err.code === 'ELOCKNOTACQUIRED'
        );
        await lock.releaseLock(holder);
    } finally {
        await lock.close();
        await redis.quit();
    }

    console.log('CommonJS smoke test passed (' + process.version + ', ' + (process.env.NODE_OPTIONS || 'no NODE_OPTIONS') + ')');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
