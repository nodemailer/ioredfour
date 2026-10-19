'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Lock = require('../lib/ioredfour.js');
const Redis = require('ioredis');
const events = require('events');

const REDIS_STANDALONE_CONFIG = process.env.REDIS_STANDALONE_URL || 'redis://localhost:6379/11';
// Comma-separated host:port list, matching what scripts/redis-cluster.sh starts by default
const REDIS_CLUSTER_NODES = (process.env.REDIS_CLUSTER_NODES || '127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102').split(',').map(node => {
    const [host, port] = node.trim().split(':');
    return { host, port: Number(port) };
});
const TEST_TARGET = process.env.TEST_TARGET || 'standalone';
const RUN_STANDALONE = TEST_TARGET === 'standalone' || TEST_TARGET === 'all';
const RUN_CLUSTER = TEST_TARGET === 'cluster' || TEST_TARGET === 'all';
// node:test applies a describe() timeout to the whole suite, so the per-test mocha timeouts are passed to each it()
const TEST_OPTS = { timeout: 10000 };
const CLUSTER_TEST_OPTS = { timeout: 15000 };
const describeStandalone = RUN_STANDALONE ? describe : describe.skip;
const describeCluster = RUN_CLUSTER ? describe : describe.skip;

// We need an unique key just in case a previous test run ended with an exception
// and testing keys were not immediately deleted (these expire automatically after a while)
let testKey = 'TEST:' + Date.now();

describeStandalone('lock', () => {
    let testLock;

    beforeEach((t, done) => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        testLock = new Lock({
            redis,
            namespace: 'testLock',
            minReplications: 0
        });

        done();
    });

    it('should acquire and release a lock only with a valid index', TEST_OPTS, async () => {
        const lock = await testLock.acquireLock(testKey, 60 * 100);
        assert.strictEqual(lock.success, true);
        assert.strictEqual(lock.id, testKey);
        assert.ok(lock.index > 0);

        const invalidLock = await testLock.acquireLock(testKey, 60 * 100);
        assert.strictEqual(invalidLock.success, false);

        const invalidRelease = await testLock.releaseLock({
            id: testKey,
            index: -10
        });
        assert.strictEqual(invalidRelease.success, false);

        const release = await testLock.releaseLock(lock);
        assert.strictEqual(release.success, true);
    });

    it('should wait and acquire a lock after releasing', TEST_OPTS, async () => {
        const initialLock = await testLock.acquireLock(testKey, 1 * 60 * 1000);
        assert.strictEqual(initialLock.success, true);

        let start = Date.now();
        setTimeout(() => {
            testLock.releaseLock(initialLock);
        }, 1500);
        const newLock = await testLock.waitAcquireLock(testKey, 60 * 100, 3000);
        assert.strictEqual(newLock.success, true);
        assert.ok(Date.now() - start > 1450);

        await testLock.releaseLock(newLock);
    });

    it('should wait and acquire a lock after expiring', TEST_OPTS, async () => {
        const initialLock = await testLock.acquireLock(testKey, 1.5 * 1000);
        assert.strictEqual(initialLock.success, true);

        let start = Date.now();
        const newLock = await testLock.waitAcquireLock(testKey, 60 * 100, 3000);
        assert.strictEqual(newLock.success, true);
        assert.ok(Date.now() - start > 1450);

        await testLock.releaseLock(newLock);
    });

    it('should wait and acquire a lock after extending', TEST_OPTS, async () => {
        const initialLock = await testLock.acquireLock(testKey, 1 * 1000);
        assert.strictEqual(initialLock.success, true);
        setTimeout(() => {
            testLock.extendLock(initialLock, 10000);
        }, 500);
        setTimeout(() => {
            testLock.releaseLock(initialLock);
        }, 1500);

        let start = Date.now();
        const newLock = await testLock.waitAcquireLock(testKey, 60 * 100, 3000);
        assert.strictEqual(newLock.success, true);
        assert.ok(Date.now() - start > 1450);

        await testLock.releaseLock(newLock);
    });

    it('Should wait and not acquire a lock', TEST_OPTS, async () => {
        const initialLock = await testLock.acquireLock(testKey, 1 * 60 * 1000);
        assert.strictEqual(initialLock.success, true);

        let start = Date.now();
        const newLock = await testLock.waitAcquireLock(testKey, 1 * 60 * 1000, 1500);
        assert.strictEqual(newLock.success, false);
        assert.ok(Date.now() - start > 1450);
        // A waiter that gave up must not leave its release listener behind
        assert.strictEqual(testLock._subscribers.listenerCount(testLock._lockKey(testKey)), 0);
        await testLock.releaseLock(initialLock);
    });

    it('Should be able to be constructed from a pre-existing connection', TEST_OPTS, async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        let testExistingLock = new Lock({
            redis,
            namespace: 'testExistingLock'
        });

        const initialLock = await testExistingLock.acquireLock(testKey, 1 * 60 * 1000);
        assert.strictEqual(initialLock.success, true);
        setTimeout(() => {
            testExistingLock.releaseLock(initialLock);
        }, 1500);

        let start = Date.now();
        const newLock = await testExistingLock.waitAcquireLock(testKey, 60 * 100, 3000);
        assert.strictEqual(newLock.success, true);
        assert.ok(Date.now() - start > 1450);

        await testExistingLock.releaseLock(newLock);
    });

    it('Should support redisConnection alias for a pre-existing connection', TEST_OPTS, async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        let testExistingLock = new Lock({
            redisConnection: redis,
            namespace: 'testExistingLockAlias'
        });

        const lock = await testExistingLock.acquireLock(testKey, 1 * 60 * 1000);
        assert.strictEqual(lock.success, true);
        await testExistingLock.releaseLock(lock);
    });

    it('also works with callbacks', TEST_OPTS, (t, done) => {
        testLock.acquireLock(testKey, 1 * 1000, (err, initialLock) => {
            assert.ok(!err);
            assert.strictEqual(initialLock.success, true);
            setTimeout(() => {
                testLock.extendLock(initialLock, 10000, err => {
                    assert.ok(!err);
                });
            }, 500);
            setTimeout(() => {
                testLock.releaseLock(initialLock, err => {
                    assert.ok(!err);
                });
            }, 1500);

            let start = Date.now();
            testLock.waitAcquireLock(testKey, 60 * 100, 3000, (err, newLock) => {
                assert.ok(!err);
                assert.strictEqual(newLock.success, true);
                assert.ok(Date.now() - start > 1450);

                testLock.releaseLock(newLock, err => {
                    assert.ok(!err);
                    done();
                });
            });
        });
    });

    it('should throw if redis is not provided', TEST_OPTS, () => {
        assert.throws(
            () =>
                new Lock({
                    namespace: 'testExistingLock'
                }),
            /must provide redis/i
        );
    });

    it('should work with namespace ending in -release', TEST_OPTS, async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const lockWithReleaseNamespace = new Lock({
            redis,
            namespace: 'auto-release'
        });
        const key = `${testKey}:auto-release`;

        const lock = await lockWithReleaseNamespace.acquireLock(key, 60 * 1000);
        assert.strictEqual(lock.success, true);

        const release = await lockWithReleaseNamespace.releaseLock(lock);
        assert.strictEqual(release.success, true);
        assert.strictEqual(release.result, 'released');
    });

    it('should mark replication failure and release lock when minReplications is too high', TEST_OPTS, async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const replicationLock = new Lock({
            redis,
            namespace: 'replicationFailure',
            minReplications: 999,
            replicationTimeout: 10
        });
        const key = `${testKey}:replication-failure`;

        const failedLock = await replicationLock.acquireLock(key, 60 * 1000);
        assert.strictEqual(failedLock.success, false);
        assert.strictEqual(failedLock.replicationFailure, true);

        // Use a lock without minReplications to verify the failed lock was auto-released
        const verifyLock = new Lock({
            redis,
            namespace: 'replicationFailure'
        });
        const nextLock = await verifyLock.acquireLock(key, 60 * 1000);
        assert.strictEqual(nextLock.success, true);

        await verifyLock.releaseLock(nextLock);
        redis.disconnect();
    });

    it('should retry replication and return failure after deadline expires', TEST_OPTS, async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const replicationLock = new Lock({
            redis,
            namespace: 'replicationRetry',
            minReplications: 1,
            replicationTimeout: 200
        });
        const key = `${testKey}:replication-retry`;

        const failedLock = await replicationLock.acquireLock(key, 2000);
        assert.strictEqual(failedLock.success, false);
        assert.strictEqual(failedLock.replicationFailure, true);

        // Verify lock is cleaned up after retries
        const verifyLock = new Lock({
            redis,
            namespace: 'replicationRetry'
        });
        const nextLock = await verifyLock.acquireLock(key, 60 * 1000);
        assert.strictEqual(nextLock.success, true);

        await verifyLock.releaseLock(nextLock);
        redis.disconnect();
    });

    it('should reject when TTL is too short relative to replicationTimeout', TEST_OPTS, async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const lock = new Lock({
            redis,
            namespace: 'ttlValidation',
            minReplications: 1,
            replicationTimeout: 1000
        });
        try {
            await lock.acquireLock(`${testKey}:ttl-short`, 1000);
            assert.fail('should have thrown');
        } catch (err) {
            assert.match(err.message, /must be at least 1\.5x/);
        } finally {
            redis.disconnect();
        }
    });

    it('should pass TTL validation error to callback', TEST_OPTS, (t, done) => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const lock = new Lock({
            redis,
            namespace: 'ttlValidationCb',
            minReplications: 1,
            replicationTimeout: 1000
        });
        lock.acquireLock(`${testKey}:ttl-cb`, 500, err => {
            assert.ok(err);
            assert.match(err.message, /must be at least 1\.5x/);
            redis.disconnect();
            done();
        });
    });
});

describeStandalone('lock hardening', () => {
    let key;
    let connections;

    beforeEach(() => {
        key = `${testKey}:hardening:${Math.random()}`;
        connections = [];
    });

    afterEach(async () => {
        for (let connection of connections) {
            await connection.close();
        }
    });

    let makeLock = options => {
        let lock = new Lock(options);
        connections.push(lock);
        return lock;
    };

    let makeRedis = opts => {
        let redis = new Redis(REDIS_STANDALONE_CONFIG, opts);
        connections.push({ close: () => redis.quit() });
        return redis;
    };

    // Resolves to the rejection reason, or undefined when the promise fulfilled
    let rejection = p =>
        p.then(
            () => undefined,
            err => err
        );

    it('should keep working when the release channel subscription is refused', TEST_OPTS, async () => {
        const redis = makeRedis();

        // Simulates a Redis ACL user without channel permissions (NOPERM on SUBSCRIBE)
        const originalDuplicate = redis.duplicate.bind(redis);
        redis.duplicate = (...args) => {
            const subscriber = originalDuplicate(...args);
            subscriber.subscribe = () => Promise.reject(new Error("NOPERM User has no permissions to access the 'x' channel"));
            return subscriber;
        };

        const unhandled = [];
        const onUnhandled = err => unhandled.push(err);
        process.on('unhandledRejection', onUnhandled);

        try {
            const lock = makeLock({ redis, namespace: 'testNoPubSub' });

            const [error] = await events.once(lock, 'error');
            assert.match(error.message, /NOPERM/);
            assert.strictEqual(lock._pubsubRefused, true);

            const first = await lock.acquireLock(key, 60 * 1000);
            assert.strictEqual(first.success, true);

            // Without notifications the waiter polls instead of sleeping out the 60s TTL
            setTimeout(() => lock.releaseLock(first), 300);
            const start = Date.now();
            const second = await lock.waitAcquireLock(key, 60 * 1000, 5000);
            assert.strictEqual(second.success, true);
            assert.ok(Date.now() - start < 2500);

            const release = await lock.releaseLock(second);
            assert.strictEqual(release.success, true);

            await new Promise(resolve => setImmediate(resolve));
            assert.deepStrictEqual(unhandled, []);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    it('should reject a missing or non-integer TTL without leaving a lock behind', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testTtlValidation' });

        for (let ttl of [undefined, null, 1.5, '1000', 0, -5, NaN]) {
            const error = await rejection(lock.acquireLock(key, ttl));
            assert.ok(error instanceof TypeError, `ttl ${ttl}`);
            assert.match(error.message, /positive integer/);
            assert.strictEqual(await redis.exists(lock._lockKey(key)), 0);
        }

        assert.ok((await rejection(lock.waitAcquireLock(key, undefined, 100))) instanceof TypeError);

        const acquired = await lock.acquireLock(key, 60 * 1000);
        assert.ok((await rejection(lock.extendLock(acquired, 2.5))) instanceof TypeError);
        assert.ok((await redis.pttl(lock._lockKey(key))) > 50 * 1000);
        await lock.releaseLock(acquired);
    });

    it('should not create a lock key without expiry when the script gets a bad TTL', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testTtlScript' });

        // Bypasses the JavaScript validation to exercise the Lua guard itself
        for (let ttl of ['', 'abc', '1.5', '0']) {
            const error = await rejection(redis[lock.fn('acquireLock')](lock._lockKey(key), lock._indexKey(), ttl));
            assert.ok(error, `ttl ${JSON.stringify(ttl)}`);
            assert.strictEqual(await redis.exists(lock._lockKey(key)), 0);
        }
    });

    for (let { title, redisOptions, namespace } of [
        // Before the keyPrefix fix the waiter only woke up when its 3s wait ran out, and then failed
        { title: 'when the client uses a keyPrefix', redisOptions: { keyPrefix: 'ior4prefix:' }, namespace: 'testKeyPrefix' },
        { title: 'for a namespace containing quotes and backslashes', redisOptions: undefined, namespace: 'test"quoted\\ns' }
    ]) {
        it(`should deliver release notifications ${title}`, TEST_OPTS, async () => {
            const redis = makeRedis(redisOptions);
            const lock = makeLock({ redis, namespace });

            const first = await lock.acquireLock(key, 60 * 1000);
            assert.strictEqual(first.success, true);

            setTimeout(() => lock.releaseLock(first), 300);
            const start = Date.now();
            const second = await lock.waitAcquireLock(key, 60 * 1000, 3000);
            assert.strictEqual(second.success, true);
            assert.ok(Date.now() - start < 1500);

            const release = await lock.releaseLock(second);
            assert.strictEqual(release.success, true);
            assert.strictEqual(release.result, 'released');
        });
    }

    it('should close the duplicated subscriber and leave the caller connection open', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = new Lock({ redis, namespace: 'testClose' });

        const errors = [];
        lock.on('error', err => errors.push(err));
        lock._redisSubscriber.emit('error', new Error('subscriber failure'));
        assert.deepStrictEqual(
            errors.map(err => err.message),
            ['subscriber failure']
        );

        await lock.close();
        assert.strictEqual(lock._redisSubscriber.status, 'end');
        assert.strictEqual(await redis.ping(), 'PONG');
    });

    it('should close both connections when it opened them itself', TEST_OPTS, async () => {
        const lock = new Lock({ redis: REDIS_STANDALONE_CONFIG, namespace: 'testCloseOwned' });
        const acquired = await lock.acquireLock(key, 1000);
        await lock.releaseLock(acquired);

        await lock.close();
        assert.strictEqual(lock._redisSubscriber.status, 'end');
        assert.strictEqual(lock._redisConnection.status, 'end');
    });
});

describeCluster('cluster mode', () => {
    let testClusterLock;

    beforeEach((t, done) => {
        testClusterLock = new Lock({
            cluster: REDIS_CLUSTER_NODES,
            namespace: `testClusterLock:${Date.now()}:${Math.random()}`
        });
        testClusterLock._redisConnection.on('error', () => false);
        testClusterLock._redisSubscriber.on('error', () => false);
        done();
    });

    afterEach((t, done) => {
        if (testClusterLock) {
            if (testClusterLock._redisConnection) {
                testClusterLock._redisConnection.disconnect();
            }
            if (testClusterLock._redisSubscriber) {
                testClusterLock._redisSubscriber.disconnect();
            }
        }
        done();
    });

    it('should acquire and release a lock in cluster mode', CLUSTER_TEST_OPTS, async () => {
        const key = `${testKey}:cluster:acquire-release`;
        const lock = await testClusterLock.acquireLock(key, 60 * 1000);
        assert.strictEqual(lock.success, true);
        assert.strictEqual(lock.id, key);
        assert.ok(lock.index > 0);

        const invalidLock = await testClusterLock.acquireLock(key, 60 * 1000);
        assert.strictEqual(invalidLock.success, false);

        const release = await testClusterLock.releaseLock(lock);
        assert.strictEqual(release.success, true);
        assert.strictEqual(release.result, 'released');
    });

    it('should use hash-tagged release channel in cluster mode', CLUSTER_TEST_OPTS, () => {
        assert.match(testClusterLock._releaseChannel, /\{ior4_[a-f0-9]{12}\}-release$/);
    });

    it('should apply clusterOptions when cluster is provided as an array', CLUSTER_TEST_OPTS, () => {
        const lockWithOptions = new Lock({
            cluster: REDIS_CLUSTER_NODES,
            clusterOptions: {
                slotsRefreshTimeout: 4321
            },
            namespace: `clusterOptionsArray:${Date.now()}:${Math.random()}`
        });
        lockWithOptions._redisConnection.on('error', () => false);
        lockWithOptions._redisSubscriber.on('error', () => false);

        assert.strictEqual(lockWithOptions._redisConnection.options.slotsRefreshTimeout, 4321);

        lockWithOptions._redisConnection.disconnect();
        lockWithOptions._redisSubscriber.disconnect();
    });

    it('should support pre-existing cluster redisConnection by duplicating with sharded subscribers', CLUSTER_TEST_OPTS, () => {
        const clusterConnection = new Redis.Cluster(REDIS_CLUSTER_NODES);
        clusterConnection.on('error', () => false);

        let lock = new Lock({
            redisConnection: clusterConnection,
            namespace: `clusterPreExisting:${Date.now()}:${Math.random()}`
        });
        lock._redisSubscriber.on('error', () => false);

        assert.strictEqual(lock._clusterMode, true);
        assert.strictEqual(lock._redisSubscriber.options.shardedSubscribers, true);
        assert.notStrictEqual(lock._redisSubscriber, clusterConnection);

        lock._redisSubscriber.disconnect();
        clusterConnection.disconnect();
    });

    it('should wait and acquire after release via cluster pub/sub notification', CLUSTER_TEST_OPTS, async () => {
        const key = `${testKey}:cluster:wait-release`;
        const initialLock = await testClusterLock.acquireLock(key, 60 * 1000);
        assert.strictEqual(initialLock.success, true);

        let start = Date.now();
        setTimeout(() => {
            testClusterLock.releaseLock(initialLock);
        }, 500);

        const newLock = await testClusterLock.waitAcquireLock(key, 60 * 100, 3000);
        let elapsed = Date.now() - start;

        assert.strictEqual(newLock.success, true);
        assert.ok(elapsed > 450);
        assert.ok(elapsed < 4000);

        await testClusterLock.releaseLock(newLock);
    });

    it('should extend a lock in cluster mode', CLUSTER_TEST_OPTS, async () => {
        const key = `${testKey}:cluster:extend`;
        const initialLock = await testClusterLock.acquireLock(key, 700);
        assert.strictEqual(initialLock.success, true);

        const extended = await testClusterLock.extendLock(initialLock, 3000);
        assert.strictEqual(extended.success, true);
        assert.strictEqual(extended.ttl, 3000);

        const invalidLock = await testClusterLock.acquireLock(key, 60 * 1000);
        assert.strictEqual(invalidLock.success, false);

        await testClusterLock.releaseLock(initialLock);
    });

    it('should report replication failure when minReplications is too high in cluster mode', CLUSTER_TEST_OPTS, async () => {
        const highReplicationClusterLock = new Lock({
            cluster: REDIS_CLUSTER_NODES,
            namespace: `testClusterReplication:${Date.now()}:${Math.random()}`,
            minReplications: 999,
            replicationTimeout: 20
        });
        highReplicationClusterLock._redisConnection.on('error', () => false);
        highReplicationClusterLock._redisSubscriber.on('error', () => false);

        const key = `${testKey}:cluster:replication-failure`;
        const failedLock = await highReplicationClusterLock.acquireLock(key, 60 * 1000);

        assert.strictEqual(failedLock.success, false);
        assert.strictEqual(failedLock.replicationFailure, true);

        highReplicationClusterLock._redisConnection.disconnect();
        highReplicationClusterLock._redisSubscriber.disconnect();
    });

    it('should handle replication checks in cluster mode', CLUSTER_TEST_OPTS, async () => {
        const namespace = `testClusterReplicationGeneral:${Date.now()}:${Math.random()}`;
        const replicationClusterLock = new Lock({
            cluster: REDIS_CLUSTER_NODES,
            namespace,
            minReplications: 1,
            replicationTimeout: 200
        });
        replicationClusterLock._redisConnection.on('error', () => false);
        replicationClusterLock._redisSubscriber.on('error', () => false);

        const key = `${testKey}:cluster:replication-general`;
        let verificationLock;
        try {
            const lock = await replicationClusterLock.acquireLock(key, 60 * 1000);
            assert.strictEqual(lock.id, key);
            assert.strictEqual(typeof lock.index, 'number');
            assert.strictEqual(typeof lock.ttl, 'number');

            if (lock.success) {
                assert.notStrictEqual(lock.replicationFailure, true);
                const release = await replicationClusterLock.releaseLock(lock);
                assert.strictEqual(release.success, true);
            } else {
                assert.strictEqual(lock.replicationFailure, true);
                verificationLock = new Lock({
                    cluster: REDIS_CLUSTER_NODES,
                    namespace,
                    minReplications: 0
                });
                verificationLock._redisConnection.on('error', () => false);
                verificationLock._redisSubscriber.on('error', () => false);

                const retryLock = await verificationLock.acquireLock(key, 60 * 1000);
                assert.strictEqual(retryLock.success, true);
                await verificationLock.releaseLock(retryLock);
            }
        } finally {
            if (verificationLock) {
                verificationLock._redisConnection.disconnect();
                verificationLock._redisSubscriber.disconnect();
            }
            replicationClusterLock._redisConnection.disconnect();
            replicationClusterLock._redisSubscriber.disconnect();
        }
    });
});
