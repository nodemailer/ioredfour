import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import Lock from '../src/ioredfour.js';
import { MAX_TTL } from '../src/scripts.js';
import { TEST_OPTS, connectionTracker, describeStandalone, rejection, waitFor } from './fixtures/redis.js';

const DAY = 24 * 3600 * 1000;

describeStandalone('lock regressions', () => {
    let key: string;
    const { makeRedis, makeLock, closeAll } = connectionTracker();

    beforeEach(() => {
        key = `TEST:${Date.now()}:regression:${Math.random()}`;
    });

    afterEach(closeAll);

    it('should acquire and extend a lock with a TTL up to MAX_TTL', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testLongTtl' });
        const ttl = 123456789012345;

        const acquired = await lock.acquireLock(key, ttl);
        assert.strictEqual(acquired.success, true);
        assert.strictEqual(acquired.ttl, ttl);
        assert.ok((await redis.pttl(lock._lockKey(key))) > ttl - 60 * 1000);

        const extended = await lock.extendLock(acquired, MAX_TTL);
        assert.strictEqual(extended.success, true);
        assert.strictEqual(extended.ttl, MAX_TTL);
        assert.ok((await redis.pttl(lock._lockKey(key))) > ttl);

        assert.strictEqual((await lock.releaseLock(acquired)).result, 'released');
    });

    it('should reject a TTL above MAX_TTL without creating a key', TEST_OPTS, async () => {
        // 1e20 passed the old checks, PEXPIRE failed after the HSET and the lock never expired
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testHugeTtl' });

        for (const ttl of [MAX_TTL + 1, Number.MAX_SAFE_INTEGER, 1e20, Infinity]) {
            const error = await rejection(lock.acquireLock(key, ttl));
            assert.ok(error instanceof TypeError, `ttl ${ttl}`);
            assert.strictEqual(await redis.exists(lock._lockKey(key)), 0);
        }
    });

    it('should accept only plain decimal digit strings as the TTL in the scripts', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testLuaTtl' });
        const acquire = (ttl: string) => (redis as any)[lock.fn('acquireLock')](lock._lockKey(key), lock._indexKey(), ttl);

        for (const ttl of ['0x10', '1e3', '5.0', ' 5', '5 ', '+5', '05', '1e20', '1000000000000000', '9007199254740991']) {
            const error = await rejection(acquire(ttl));
            assert.ok(error instanceof Error, `ttl ${JSON.stringify(ttl)} was accepted`);
            assert.match(error.message, /positive integer/);
            assert.strictEqual(await redis.exists(lock._lockKey(key)), 0, `ttl ${JSON.stringify(ttl)} left a key`);
        }

        const acquired = await lock.acquireLock(key, 60 * 1000);
        for (const ttl of ['0x10', '5.0', '1e20']) {
            const error = await rejection((redis as any)[lock.fn('extendLock')](lock._lockKey(key), acquired.index, ttl));
            assert.ok(error instanceof Error, `extend ttl ${JSON.stringify(ttl)} was accepted`);
        }
        assert.ok((await redis.pttl(lock._lockKey(key))) > 50 * 1000);
    });

    it('should not busy-poll while the lock holder has a TTL longer than the largest timer delay', TEST_OPTS, async t => {
        // setTimeout() fires after 1ms for delays above 2^31-1, so a waiter used to retry nonstop
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testLongHolder' });
        const holder = await lock.acquireLock(key, 30 * DAY);
        assert.strictEqual(holder.success, true);

        const warnings: Error[] = [];
        const onWarning = (warning: Error) => warnings.push(warning);
        process.on('warning', onWarning);
        const acquire = t.mock.method(lock, 'acquireLock');
        try {
            const waited = await lock.waitAcquireLock(key, 1000, 500);
            assert.strictEqual(waited.success, false);
            assert.ok(acquire.mock.callCount() <= 3, `acquireLock was called ${acquire.mock.callCount()} times`);
            assert.deepStrictEqual(
                warnings.filter(warning => warning.name === 'TimeoutOverflowWarning'),
                []
            );
        } finally {
            process.removeListener('warning', onWarning);
        }
        await lock.releaseLock(holder);
    });

    it('should keep waiting when waitTtl is longer than the largest timer delay', TEST_OPTS, async () => {
        // A 30 day wait used to give up after 1ms
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testLongWait' });
        const holder = await lock.acquireLock(key, 60 * 1000);

        setTimeout(() => lock.releaseLock(holder), 300);
        const waited = await lock.waitAcquireLock(key, 1000, 30 * DAY);
        assert.strictEqual(waited.success, true);
        await lock.releaseLock(waited);
    });

    it('should split a wait longer than the largest timer delay into several timers', TEST_OPTS, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const lock = Object.create(Lock.prototype) as Lock;
        // Every attempt finds the lock taken by a holder with a short TTL
        lock._subscribers = new EventEmitter();
        lock._pubsubRefused = false;
        lock._lockKey = (id: string | number) => `lock:${id}`;
        let attempts = 0;
        lock.acquireLock = (() => {
            attempts++;
            return Promise.resolve({ id: key, success: false, index: -1, ttl: 2 ** 31 });
        }) as any;

        let settled: any;
        lock.waitAcquireLock(key, 1000, 2 ** 31 + 1000).then(result => (settled = result));
        const flush = () => new Promise(resolve => setImmediate(resolve));
        await flush();
        assert.strictEqual(attempts, 1);

        // Past the first timer of the wait, still waiting
        t.mock.timers.tick(2 ** 31 - 1);
        await flush();
        assert.ok(settled === undefined, 'the waiter gave up early');

        // The remainder of the wait ran out, the last attempt resolves the waiter
        t.mock.timers.tick(1001);
        await flush();
        await flush();
        assert.strictEqual(settled?.success, false);
    });

    it('should not start another attempt when the wait runs out while one is in flight', TEST_OPTS, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const lock = Object.create(Lock.prototype) as Lock;
        lock._subscribers = new EventEmitter();
        lock._pubsubRefused = false;
        lock._lockKey = (id: string | number) => `lock:${id}`;
        const pending: ((result: any) => void)[] = [];
        lock.acquireLock = (() => new Promise(resolve => pending.push(resolve))) as any;

        let settled: any;
        lock.waitAcquireLock(key, 1000, 100).then(result => (settled = result));
        const flush = () => new Promise(resolve => setImmediate(resolve));
        await flush();
        assert.strictEqual(pending.length, 1);

        // The wait runs out with the first attempt still waiting for Redis
        t.mock.timers.tick(100);
        await flush();
        assert.strictEqual(pending.length, 1);

        // Its answer is the final one
        pending[0]!({ id: key, success: false, index: -1, ttl: 5000 });
        await flush();
        assert.strictEqual(settled?.success, false);
        assert.strictEqual(pending.length, 1);
    });

    it('should wake waiters when the subscriber reconnects, a release published meanwhile is lost', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testResubscribe' });
        lock.on('error', () => false);
        const holder = await lock.acquireLock(key, 60 * 1000);
        await waitFor(() => lock._pubsubSubscribed);

        const start = Date.now();
        const waiting = lock.waitAcquireLock(key, 1000, 5000);
        await new Promise(resolve => setTimeout(resolve, 100));

        // The release happens while the subscriber is gone, so its notification is never delivered
        const subscriber = lock._redisSubscriber as Redis;
        subscriber.disconnect(true);
        const released = await redis.del(lock._lockKey(holder.id));
        assert.strictEqual(released, 1);

        const waited = await waiting;
        assert.strictEqual(waited.success, true);
        assert.ok(Date.now() - start < 3000, `waited ${Date.now() - start}ms`);
        await lock.releaseLock(waited);
    });

    it('should wake waiters once the first subscription is active', TEST_OPTS, async () => {
        const redis = makeRedis();
        let finishSubscribe: () => void = () => undefined;
        const originalDuplicate = redis.duplicate.bind(redis);
        redis.duplicate = (...args: any[]) => {
            const subscriber = originalDuplicate(...args);
            const subscribe = subscriber.subscribe.bind(subscriber);
            // Holds the SUBSCRIBE back until the test releases it
            subscriber.subscribe = ((...channels: any[]) => new Promise(resolve => (finishSubscribe = () => resolve(subscribe(...channels))))) as any;
            return subscriber;
        };
        const lock = makeLock({ redis, namespace: 'testFirstSubscribe' });
        const holder = await lock.acquireLock(key, 60 * 1000);

        const start = Date.now();
        const waiting = lock.waitAcquireLock(key, 1000, 5000);
        await new Promise(resolve => setTimeout(resolve, 100));
        // Published while nobody is subscribed yet
        await lock.releaseLock(holder);
        finishSubscribe();

        const waited = await waiting;
        assert.strictEqual(waited.success, true);
        assert.ok(Date.now() - start < 3000, `waited ${Date.now() - start}ms`);
        await lock.releaseLock(waited);
    });

    it('should not modify the options object', TEST_OPTS, () => {
        const redis = makeRedis();
        const options = Object.freeze({ redisConnection: redis, namespace: 'testFrozenOptions' });
        const lock = makeLock(options);
        assert.strictEqual(lock._redisConnection, redis);
        assert.ok(!('redis' in options));
    });

    it('should reject, not throw, when releaseLock or extendLock gets no lock', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testNoLock' });

        for (const value of [undefined, null, 'lock', {}, { id: 'x' }, { index: 1 }, { id: {}, index: 1 }]) {
            assert.ok((await rejection(lock.releaseLock(value as any))) instanceof TypeError);
            assert.ok((await rejection(lock.extendLock(value as any, 1000))) instanceof TypeError);
        }

        const error = await new Promise(resolve => lock.releaseLock(undefined as any, err => resolve(err)));
        assert.ok(error instanceof TypeError);
    });

    it('should report the outcome of release and extend calls', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testOutcomes' });

        const first = await lock.acquireLock(key, 60 * 1000);
        assert.deepStrictEqual(await lock.releaseLock(first), { id: key, success: true, result: 'released', index: first.index });
        assert.deepStrictEqual(await lock.releaseLock(first), { id: key, success: true, result: 'expired', index: 0 });
        assert.deepStrictEqual(await lock.extendLock(first, 1000), { id: key, success: false, index: undefined, ttl: undefined });

        const second = await lock.acquireLock(key, 60 * 1000);
        assert.ok(second.index > first.index);
        assert.deepStrictEqual(await lock.releaseLock(first), { id: key, success: false, result: 'conflict', index: second.index });
        assert.deepStrictEqual(await lock.extendLock(first, 1000), { id: key, success: false, index: undefined, ttl: undefined });
        assert.deepStrictEqual(await lock.extendLock(second, 5000), { id: key, success: true, index: second.index, ttl: 5000 });

        const taken = await lock.acquireLock(key, 1000);
        assert.strictEqual(taken.success, false);
        assert.strictEqual(taken.index, -1);
        assert.ok(taken.ttl > 4000 && taken.ttl <= 5000);
        await lock.releaseLock(second);
    });

    it('should resolve a waiter that gave up with the last attempt even when it races the expiry', TEST_OPTS, async () => {
        const redis = makeRedis();
        const lock = makeLock({ redis, namespace: 'testWaitExpiry' });
        const holder = await lock.acquireLock(key, 60 * 1000);

        const waited = await lock.waitAcquireLock(key, 1000, 150);
        assert.strictEqual(waited.success, false);
        assert.strictEqual(lock._subscribers.listenerCount(lock._lockKey(key)), 0);
        await lock.releaseLock(holder);
    });
});
