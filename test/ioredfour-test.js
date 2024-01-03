/* eslint no-unused-expressions:0 */

'use strict';

const Lock = require('../lib/ioredfour.js');
const expect = require('chai').expect;
const Redis = require('ioredis');

const REDIS_CONFIG = process.env.REDIS_URL || 'redis://localhost:6379/11';

// We need an unique key just in case a previous test run ended with an exception
// and testing keys were not immediately deleted (these expire automatically after a while)
let testKey = 'TEST:' + Date.now();

describe('lock', function () {
    this.timeout(10000); //eslint-disable-line no-invalid-this

    let testLock;

    beforeEach(done => {
        const redis = new Redis(REDIS_CONFIG);
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
        const redis = new Redis(REDIS_CONFIG);
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
        ).to.throw(/must provide a redis/i);
    });
});
