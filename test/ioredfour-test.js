/* eslint no-unused-expressions:0 */

'use strict';

const Lock = require('../lib/ioredfour.js');
const expect = require('chai').expect;
const Redis = require('ioredis');
const events = require('events');

const REDIS_STANDALONE_CONFIG = process.env.REDIS_STANDALONE_URL || 'redis://localhost:6379/11';
const REDIS_CLUSTER_NODES = [
    { host: 'localhost', port: 7000 },
    { host: 'localhost', port: 7001 },
    { host: 'localhost', port: 7002 }
];
const TEST_TARGET = process.env.TEST_TARGET || 'standalone';
const RUN_STANDALONE = TEST_TARGET === 'standalone' || TEST_TARGET === 'all';
const RUN_CLUSTER = TEST_TARGET === 'cluster' || TEST_TARGET === 'all';
const describeStandalone = RUN_STANDALONE ? describe : describe.skip;
const describeCluster = RUN_CLUSTER ? describe : describe.skip;

// We need an unique key just in case a previous test run ended with an exception
// and testing keys were not immediately deleted (these expire automatically after a while)
let testKey = 'TEST:' + Date.now();

describeStandalone('lock', function () {
    this.timeout(10000); //eslint-disable-line no-invalid-this

    let testLock;

    beforeEach(done => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        testLock = new Lock({
            redis,
            namespace: 'testLock',
            minReplications: 0
        });

        done();
    });

    it('should acquire and release a lock only with a valid index', async () => {
        const lock = await testLock.acquireLock(testKey, 60 * 100);
        expect(lock.success).to.equal(true);
        expect(lock.id).to.equal(testKey);
        expect(lock.index).to.be.above(0);

        const invalidLock = await testLock.acquireLock(testKey, 60 * 100);
        expect(invalidLock.success).to.equal(false);

        const invalidRelease = await testLock.releaseLock({
            id: testKey,
            index: -10
        });
        expect(invalidRelease.success).to.equal(false);

        const release = await testLock.releaseLock(lock);
        expect(release.success).to.equal(true);
    });

    it('should wait and acquire a lock after releasing', async () => {
        const initialLock = await testLock.acquireLock(testKey, 1 * 60 * 1000);
        expect(initialLock.success).to.equal(true);

        let start = Date.now();
        setTimeout(() => {
            testLock.releaseLock(initialLock);
        }, 1500);
        const newLock = await testLock.waitAcquireLock(testKey, 60 * 100, 3000);
        expect(newLock.success).to.equal(true);
        expect(Date.now() - start).to.be.above(1450);

        await testLock.releaseLock(newLock);
    });

    it('should wait and acquire a lock after expiring', async () => {
        const initialLock = await testLock.acquireLock(testKey, 1.5 * 1000);
        expect(initialLock.success).to.equal(true);

        let start = Date.now();
        const newLock = await testLock.waitAcquireLock(testKey, 60 * 100, 3000);
        expect(newLock.success).to.equal(true);
        expect(Date.now() - start).to.be.above(1450);

        await testLock.releaseLock(newLock);
    });

    it('should wait and acquire a lock after extending', async () => {
        const initialLock = await testLock.acquireLock(testKey, 1 * 1000);
        expect(initialLock.success).to.equal(true);
        setTimeout(() => {
            testLock.extendLock(initialLock, 10000);
        }, 500);
        setTimeout(() => {
            testLock.releaseLock(initialLock);
        }, 1500);

        let start = Date.now();
        const newLock = await testLock.waitAcquireLock(testKey, 60 * 100, 3000);
        expect(newLock.success).to.equal(true);
        expect(Date.now() - start).to.be.above(1450);

        await testLock.releaseLock(newLock);
    });

    it('Should wait and not acquire a lock', async () => {
        const initialLock = await testLock.acquireLock(testKey, 1 * 60 * 1000);
        expect(initialLock.success).to.equal(true);

        let start = Date.now();
        const newLock = await testLock.waitAcquireLock(testKey, 1 * 60 * 1000, 1500);
        expect(newLock.success).to.equal(false);
        expect(Date.now() - start).to.be.above(1450);
        // A waiter that gave up must not leave its release listener behind
        expect(testLock._subscribers.listenerCount(testLock._lockKey(testKey))).to.equal(0);
        await testLock.releaseLock(initialLock);
    });

    it('Should be able to be constructed from a pre-existing connection', async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        let testExistingLock = new Lock({
            redis,
            namespace: 'testExistingLock'
        });

        const initialLock = await testExistingLock.acquireLock(testKey, 1 * 60 * 1000);
        expect(initialLock.success).to.equal(true);
        setTimeout(() => {
            testExistingLock.releaseLock(initialLock);
        }, 1500);

        let start = Date.now();
        const newLock = await testExistingLock.waitAcquireLock(testKey, 60 * 100, 3000);
        expect(newLock.success).to.equal(true);
        expect(Date.now() - start).to.be.above(1450);

        await testExistingLock.releaseLock(newLock);
    });

    it('Should support redisConnection alias for a pre-existing connection', async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        let testExistingLock = new Lock({
            redisConnection: redis,
            namespace: 'testExistingLockAlias'
        });

        const lock = await testExistingLock.acquireLock(testKey, 1 * 60 * 1000);
        expect(lock.success).to.equal(true);
        await testExistingLock.releaseLock(lock);
    });

    it('also works with callbacks', done => {
        testLock.acquireLock(testKey, 1 * 1000, (err, initialLock) => {
            expect(err).to.not.be.ok;
            expect(initialLock.success).to.equal(true);
            setTimeout(() => {
                testLock.extendLock(initialLock, 10000, err => {
                    expect(err).to.not.be.ok;
                });
            }, 500);
            setTimeout(() => {
                testLock.releaseLock(initialLock, err => {
                    expect(err).to.not.be.ok;
                });
            }, 1500);

            let start = Date.now();
            testLock.waitAcquireLock(testKey, 60 * 100, 3000, (err, newLock) => {
                expect(err).to.not.be.ok;
                expect(newLock.success).to.equal(true);
                expect(Date.now() - start).to.be.above(1450);

                testLock.releaseLock(newLock, err => {
                    expect(err).to.not.be.ok;
                    done();
                });
            });
        });
    });

    it('should throw if redis is not provided', () => {
        expect(
            () =>
                new Lock({
                    namespace: 'testExistingLock'
                })
        ).to.throw(/must provide redis/i);
    });

    it('should work with namespace ending in -release', async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const lockWithReleaseNamespace = new Lock({
            redis,
            namespace: 'auto-release'
        });
        const key = `${testKey}:auto-release`;

        const lock = await lockWithReleaseNamespace.acquireLock(key, 60 * 1000);
        expect(lock.success).to.equal(true);

        const release = await lockWithReleaseNamespace.releaseLock(lock);
        expect(release.success).to.equal(true);
        expect(release.result).to.equal('released');
    });

    it('should mark replication failure and release lock when minReplications is too high', async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const replicationLock = new Lock({
            redis,
            namespace: 'replicationFailure',
            minReplications: 999,
            replicationTimeout: 10
        });
        const key = `${testKey}:replication-failure`;

        const failedLock = await replicationLock.acquireLock(key, 60 * 1000);
        expect(failedLock.success).to.equal(false);
        expect(failedLock.replicationFailure).to.equal(true);

        // Use a lock without minReplications to verify the failed lock was auto-released
        const verifyLock = new Lock({
            redis,
            namespace: 'replicationFailure'
        });
        const nextLock = await verifyLock.acquireLock(key, 60 * 1000);
        expect(nextLock.success).to.equal(true);

        await verifyLock.releaseLock(nextLock);
        redis.disconnect();
    });

    it('should retry replication and return failure after deadline expires', async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const replicationLock = new Lock({
            redis,
            namespace: 'replicationRetry',
            minReplications: 1,
            replicationTimeout: 200
        });
        const key = `${testKey}:replication-retry`;

        const failedLock = await replicationLock.acquireLock(key, 2000);
        expect(failedLock.success).to.equal(false);
        expect(failedLock.replicationFailure).to.equal(true);

        // Verify lock is cleaned up after retries
        const verifyLock = new Lock({
            redis,
            namespace: 'replicationRetry'
        });
        const nextLock = await verifyLock.acquireLock(key, 60 * 1000);
        expect(nextLock.success).to.equal(true);

        await verifyLock.releaseLock(nextLock);
        redis.disconnect();
    });

    it('should reject when TTL is too short relative to replicationTimeout', async () => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const lock = new Lock({
            redis,
            namespace: 'ttlValidation',
            minReplications: 1,
            replicationTimeout: 1000
        });
        try {
            await lock.acquireLock(`${testKey}:ttl-short`, 1000);
            expect.fail('should have thrown');
        } catch (err) {
            expect(err.message).to.match(/must be at least 1\.5x/);
        } finally {
            redis.disconnect();
        }
    });

    it('should pass TTL validation error to callback', done => {
        const redis = new Redis(REDIS_STANDALONE_CONFIG);
        const lock = new Lock({
            redis,
            namespace: 'ttlValidationCb',
            minReplications: 1,
            replicationTimeout: 1000
        });
        lock.acquireLock(`${testKey}:ttl-cb`, 500, err => {
            expect(err).to.be.ok;
            expect(err.message).to.match(/must be at least 1\.5x/);
            redis.disconnect();
            done();
        });
    });
});

describeStandalone('lock hardening', function () {
    this.timeout(10000); //eslint-disable-line no-invalid-this

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

    it('should keep working when the release channel subscription is refused', async () => {
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
            expect(error.message).to.match(/NOPERM/);
            expect(lock._pubsubRefused).to.equal(true);

            const first = await lock.acquireLock(key, 60 * 1000);
            expect(first.success).to.equal(true);

            // Without notifications the waiter polls instead of sleeping out the 60s TTL
            setTimeout(() => lock.releaseLock(first), 300);
            const start = Date.now();
            const second = await lock.waitAcquireLock(key, 60 * 1000, 5000);
            expect(second.success).to.equal(true);
            expect(Date.now() - start).to.be.below(2500);

            const release = await lock.releaseLock(second);
            expect(release.success).to.equal(true);

            await new Promise(resolve => setImmediate(resolve));
            expect(unhandled).to.deep.equal([]);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    it('should reject a missing or non-integer TTL without leaving a lock behind', async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testTtlValidation' });

        for (let ttl of [undefined, null, 1.5, '1000', 0, -5, NaN]) {
            const error = await rejection(lock.acquireLock(key, ttl));
            expect(error, `ttl ${ttl}`).to.be.an.instanceof(TypeError);
            expect(error.message).to.match(/positive integer/);
            expect(await redis.exists(lock._lockKey(key))).to.equal(0);
        }

        expect(await rejection(lock.waitAcquireLock(key, undefined, 100))).to.be.an.instanceof(TypeError);

        const acquired = await lock.acquireLock(key, 60 * 1000);
        expect(await rejection(lock.extendLock(acquired, 2.5))).to.be.an.instanceof(TypeError);
        expect(await redis.pttl(lock._lockKey(key))).to.be.above(50 * 1000);
        await lock.releaseLock(acquired);
    });

    it('should not create a lock key without expiry when the script gets a bad TTL', async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testTtlScript' });

        // Bypasses the JavaScript validation to exercise the Lua guard itself
        for (let ttl of ['', 'abc', '1.5', '0']) {
            const error = await rejection(redis[lock.fn('acquireLock')](lock._lockKey(key), lock._indexKey(), ttl));
            expect(error, `ttl ${JSON.stringify(ttl)}`).to.be.ok;
            expect(await redis.exists(lock._lockKey(key))).to.equal(0);
        }
    });

    for (let { title, redisOptions, namespace } of [
        // Before the keyPrefix fix the waiter only woke up when its 3s wait ran out, and then failed
        { title: 'when the client uses a keyPrefix', redisOptions: { keyPrefix: 'ior4prefix:' }, namespace: 'testKeyPrefix' },
        { title: 'for a namespace containing quotes and backslashes', redisOptions: undefined, namespace: 'test"quoted\\ns' }
    ]) {
        it(`should deliver release notifications ${title}`, async () => {
            const redis = makeRedis(redisOptions);
            const lock = makeLock({ redis, namespace });

            const first = await lock.acquireLock(key, 60 * 1000);
            expect(first.success).to.equal(true);

            setTimeout(() => lock.releaseLock(first), 300);
            const start = Date.now();
            const second = await lock.waitAcquireLock(key, 60 * 1000, 3000);
            expect(second.success).to.equal(true);
            expect(Date.now() - start).to.be.below(1500);

            const release = await lock.releaseLock(second);
            expect(release.success).to.equal(true);
            expect(release.result).to.equal('released');
        });
    }

    it('should close the duplicated subscriber and leave the caller connection open', async () => {
        const redis = makeRedis();
        const lock = new Lock({ redis, namespace: 'testClose' });

        const errors = [];
        lock.on('error', err => errors.push(err));
        lock._redisSubscriber.emit('error', new Error('subscriber failure'));
        expect(errors.map(err => err.message)).to.deep.equal(['subscriber failure']);

        await lock.close();
        expect(lock._redisSubscriber.status).to.equal('end');
        expect(await redis.ping()).to.equal('PONG');
    });

    it('should close both connections when it opened them itself', async () => {
        const lock = new Lock({ redis: REDIS_STANDALONE_CONFIG, namespace: 'testCloseOwned' });
        const acquired = await lock.acquireLock(key, 1000);
        await lock.releaseLock(acquired);

        await lock.close();
        expect(lock._redisSubscriber.status).to.equal('end');
        expect(lock._redisConnection.status).to.equal('end');
    });
});

describeCluster('cluster mode', function () {
    this.timeout(15000); //eslint-disable-line no-invalid-this

    let testClusterLock;

    beforeEach(done => {
        testClusterLock = new Lock({
            cluster: REDIS_CLUSTER_NODES,
            namespace: `testClusterLock:${Date.now()}:${Math.random()}`
        });
        testClusterLock._redisConnection.on('error', () => false);
        testClusterLock._redisSubscriber.on('error', () => false);
        done();
    });

    afterEach(done => {
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

    it('should acquire and release a lock in cluster mode', async () => {
        const key = `${testKey}:cluster:acquire-release`;
        const lock = await testClusterLock.acquireLock(key, 60 * 1000);
        expect(lock.success).to.equal(true);
        expect(lock.id).to.equal(key);
        expect(lock.index).to.be.above(0);

        const invalidLock = await testClusterLock.acquireLock(key, 60 * 1000);
        expect(invalidLock.success).to.equal(false);

        const release = await testClusterLock.releaseLock(lock);
        expect(release.success).to.equal(true);
        expect(release.result).to.equal('released');
    });

    it('should use hash-tagged release channel in cluster mode', () => {
        expect(testClusterLock._releaseChannel).to.match(/\{ior4_[a-f0-9]{12}\}-release$/);
    });

    it('should apply clusterOptions when cluster is provided as an array', () => {
        const lockWithOptions = new Lock({
            cluster: REDIS_CLUSTER_NODES,
            clusterOptions: {
                slotsRefreshTimeout: 4321
            },
            namespace: `clusterOptionsArray:${Date.now()}:${Math.random()}`
        });
        lockWithOptions._redisConnection.on('error', () => false);
        lockWithOptions._redisSubscriber.on('error', () => false);

        expect(lockWithOptions._redisConnection.options.slotsRefreshTimeout).to.equal(4321);

        lockWithOptions._redisConnection.disconnect();
        lockWithOptions._redisSubscriber.disconnect();
    });

    it('should support pre-existing cluster redisConnection by duplicating with sharded subscribers', () => {
        const clusterConnection = new Redis.Cluster(REDIS_CLUSTER_NODES);
        clusterConnection.on('error', () => false);

        let lock = new Lock({
            redisConnection: clusterConnection,
            namespace: `clusterPreExisting:${Date.now()}:${Math.random()}`
        });
        lock._redisSubscriber.on('error', () => false);

        expect(lock._clusterMode).to.equal(true);
        expect(lock._redisSubscriber.options.shardedSubscribers).to.equal(true);
        expect(lock._redisSubscriber).to.not.equal(clusterConnection);

        lock._redisSubscriber.disconnect();
        clusterConnection.disconnect();
    });

    it('should wait and acquire after release via cluster pub/sub notification', async () => {
        const key = `${testKey}:cluster:wait-release`;
        const initialLock = await testClusterLock.acquireLock(key, 60 * 1000);
        expect(initialLock.success).to.equal(true);

        let start = Date.now();
        setTimeout(() => {
            testClusterLock.releaseLock(initialLock);
        }, 500);

        const newLock = await testClusterLock.waitAcquireLock(key, 60 * 100, 3000);
        let elapsed = Date.now() - start;

        expect(newLock.success).to.equal(true);
        expect(elapsed).to.be.above(450);
        expect(elapsed).to.be.below(4000);

        await testClusterLock.releaseLock(newLock);
    });

    it('should extend a lock in cluster mode', async () => {
        const key = `${testKey}:cluster:extend`;
        const initialLock = await testClusterLock.acquireLock(key, 700);
        expect(initialLock.success).to.equal(true);

        const extended = await testClusterLock.extendLock(initialLock, 3000);
        expect(extended.success).to.equal(true);
        expect(extended.ttl).to.equal(3000);

        const invalidLock = await testClusterLock.acquireLock(key, 60 * 1000);
        expect(invalidLock.success).to.equal(false);

        await testClusterLock.releaseLock(initialLock);
    });

    it('should report replication failure when minReplications is too high in cluster mode', async () => {
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

        expect(failedLock.success).to.equal(false);
        expect(failedLock.replicationFailure).to.equal(true);

        highReplicationClusterLock._redisConnection.disconnect();
        highReplicationClusterLock._redisSubscriber.disconnect();
    });

    it('should handle replication checks in cluster mode', async () => {
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
            expect(lock.id).to.equal(key);
            expect(lock.index).to.be.a('number');
            expect(lock.ttl).to.be.a('number');

            if (lock.success) {
                expect(lock.replicationFailure).to.not.equal(true);
                const release = await replicationClusterLock.releaseLock(lock);
                expect(release.success).to.equal(true);
            } else {
                expect(lock.replicationFailure).to.equal(true);
                verificationLock = new Lock({
                    cluster: REDIS_CLUSTER_NODES,
                    namespace,
                    minReplications: 0
                });
                verificationLock._redisConnection.on('error', () => false);
                verificationLock._redisSubscriber.on('error', () => false);

                const retryLock = await verificationLock.acquireLock(key, 60 * 1000);
                expect(retryLock.success).to.equal(true);
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
