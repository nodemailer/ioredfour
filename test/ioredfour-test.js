/* eslint no-unused-expressions:0 */

'use strict';

const Lock = require('../lib/ioredfour.js');
const expect = require('chai').expect;
const Redis = require('ioredis');

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
