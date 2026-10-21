import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Lock from '../src/ioredfour.js';
import type { ExtendResult } from '../src/ioredfour.js';
import { REDIS_STANDALONE_CONFIG, TEST_OPTS, connectionTracker, describeStandalone, rejection } from './fixtures/redis.js';
import { FUZZ_ITERATIONS, FUZZ_SEED, createRandom } from './fixtures/fuzz.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describeStandalone('withLock', () => {
    const { makeRedis, makeLock, closeAll } = connectionTracker();
    const redis = makeRedis();
    const namespace = `withLock:${Date.now()}`;
    const lock = makeLock({ redis, namespace });
    let counter = 0;
    const nextId = () => `id:${counter++}`;
    const lockKey = (id: string) => `${namespace}:${id}`;

    after(closeAll);

    it('should run the function with the lock held and release it afterwards', TEST_OPTS, async () => {
        const id = nextId();
        const value = await lock.withLock(id, 10 * 1000, 1000, async (held, signal) => {
            assert.strictEqual(held.success, true);
            assert.strictEqual(held.id, id);
            assert.ok(held.index > 0);
            assert.ok(signal instanceof AbortSignal);
            assert.strictEqual(signal.aborted, false);
            assert.strictEqual(Number(await redis.hget(lockKey(id), 'index')), held.index);
            return 'done';
        });
        assert.strictEqual(value, 'done');
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });

    it('should release the lock and reject with the error when the function throws', TEST_OPTS, async () => {
        const id = nextId();
        const failure = new Error('boom');
        assert.strictEqual(
            await rejection(
                lock.withLock(id, 10 * 1000, 1000, async () => {
                    throw failure;
                })
            ),
            failure
        );
        assert.strictEqual(await redis.exists(lockKey(id)), 0);

        // a synchronous throw is handled the same way
        const syncFailure = new Error('sync boom');
        assert.strictEqual(
            await rejection(
                lock.withLock(id, 10 * 1000, 1000, () => {
                    throw syncFailure;
                })
            ),
            syncFailure
        );
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });

    it('should accept a function that returns a plain value', TEST_OPTS, async () => {
        assert.strictEqual(await lock.withLock(nextId(), 1000, 0, held => held.index > 0), true);
    });

    it('with wait: false should try the lock once and reject at once when it is held', TEST_OPTS, async () => {
        const id = nextId();
        const holder = await lock.acquireLock(id, 10 * 1000);
        let called = false;
        const started = Date.now();
        const err: any = await rejection(
            lock.withLock(
                id,
                10 * 1000,
                5000,
                () => {
                    called = true;
                },
                { wait: false }
            )
        );
        assert.ok(err instanceof Lock.LockError);
        assert.strictEqual(err.code, 'ELOCKNOTACQUIRED');
        assert.strictEqual(called, false);
        assert.ok(Date.now() - started < 2000, 'waitTtl is ignored');
        await lock.releaseLock(holder);

        // and runs when the lock is free
        assert.strictEqual(await lock.withLock(id, 1000, 0, () => 'ran', { wait: false }), 'ran');
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });

    it('should reject with ELOCKNOTACQUIRED without calling the function when the lock is held', TEST_OPTS, async () => {
        const id = nextId();
        const holder = await lock.acquireLock(id, 10 * 1000);
        let called = false;
        const err = await rejection(
            lock.withLock(id, 10 * 1000, 50, () => {
                called = true;
            })
        );
        assert.ok(err instanceof Lock.LockError);
        assert.ok(err instanceof Error);
        assert.strictEqual(err.name, 'LockError');
        assert.strictEqual(err.code, 'ELOCKNOTACQUIRED');
        assert.strictEqual(err.id, id);
        assert.strictEqual(err.replicationFailure, false);
        assert.strictEqual(err.index, -1);
        assert.ok(err.ttl > 0 && err.ttl <= 10 * 1000);
        assert.strictEqual(called, false);
        // the holder's lock is untouched
        assert.strictEqual(Number(await redis.hget(lockKey(id), 'index')), holder.index);
        await lock.releaseLock(holder);
    });

    it('should wait for the current holder to release', TEST_OPTS, async () => {
        const id = nextId();
        const holder = await lock.acquireLock(id, 10 * 1000);
        setTimeout(() => {
            lock.releaseLock(holder).catch(() => undefined);
        }, 100);
        const started = Date.now();
        const index = await lock.withLock(id, 10 * 1000, 5000, held => held.index);
        assert.ok(index > holder.index);
        assert.ok(Date.now() - started < 5000);
    });

    it('should report a replication failure as ELOCKNOTACQUIRED', TEST_OPTS, async () => {
        const replicated = makeLock({ redis, namespace, minReplications: 999, replicationTimeout: 10 });
        const id = nextId();
        const err = await rejection(replicated.withLock(id, 1000, 50, () => 1));
        assert.ok(err instanceof Lock.LockError);
        assert.strictEqual(err.code, 'ELOCKNOTACQUIRED');
        assert.strictEqual(err.replicationFailure, true);
        assert.match(err.message, /replicated/);
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });

    it('should reject a missing function or an invalid TTL without taking the lock', TEST_OPTS, async () => {
        const id = nextId();
        const notFunction = await rejection(lock.withLock(id, 1000, 0, 'nope' as any));
        assert.ok(notFunction instanceof TypeError);
        let called = false;
        const badTtl = await rejection(
            lock.withLock(id, 0, 0, () => {
                called = true;
            })
        );
        assert.ok(badTtl instanceof TypeError);
        assert.strictEqual(called, false);
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });

    it('should pass Redis errors from acquiring through unchanged', TEST_OPTS, async t => {
        const failure = new Error('redis down');
        const broken = makeLock({ redis, namespace });
        t.mock.method(broken, 'acquireLock', () => Promise.reject(failure));
        assert.strictEqual(await rejection(broken.withLock(nextId(), 1000, 0, () => 1)), failure);
    });

    it('should not extend the lock unless asked to', TEST_OPTS, async t => {
        const extend = t.mock.method(lock, 'extendLock');
        await lock.withLock(nextId(), 100, 0, () => sleep(250));
        assert.strictEqual(extend.mock.callCount(), 0);
    });

    it('should keep an extended lock alive past its TTL and stop extending once done', TEST_OPTS, async t => {
        const id = nextId();
        const other = makeLock({ redis, namespace });
        const extend = t.mock.method(lock, 'extendLock');
        await lock.withLock(
            id,
            200,
            0,
            async (held, signal) => {
                for (let i = 0; i < 6; i++) {
                    await sleep(100);
                    const attempt = await other.acquireLock(id, 1000);
                    assert.strictEqual(attempt.success, false, `lock taken over after ${(i + 1) * 100}ms`);
                    assert.strictEqual(Number(await redis.hget(lockKey(id), 'index')), held.index);
                }
                assert.strictEqual(signal.aborted, false);
            },
            { extend: true }
        );
        const calls = extend.mock.callCount();
        assert.ok(calls >= 4, `extended ${calls} times`);
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
        await sleep(300);
        assert.strictEqual(extend.mock.callCount(), calls);
    });

    it('should abort the signal with ELOCKLOST when the lock is lost', TEST_OPTS, async () => {
        const id = nextId();
        const other = makeLock({ redis, namespace });
        let stolenIndex = 0;
        const reason = await lock.withLock(
            id,
            200,
            0,
            async (held, signal) => {
                // someone else gets the lock: the holder's TTL ran out while it was not looking
                await redis.del(lockKey(id));
                stolenIndex = (await other.acquireLock(id, 10 * 1000)).index;
                await once(signal, 'abort');
                assert.strictEqual(signal.aborted, true);
                assert.strictEqual(signal.reason.index, held.index);
                return signal.reason;
            },
            { extend: true }
        );
        assert.ok(reason instanceof Lock.LockError);
        assert.strictEqual(reason.code, 'ELOCKLOST');
        assert.strictEqual(reason.id, id);
        const cause = reason.cause as ExtendResult;
        assert.strictEqual(cause.success, false);
        // releasing the lost lock leaves the new holder alone
        assert.strictEqual(Number(await redis.hget(lockKey(id), 'index')), stolenIndex);
        await other.releaseLock({ id, index: stolenIndex });
    });

    it('should abort the signal with the Redis error as cause when an extension fails', TEST_OPTS, async t => {
        const id = nextId();
        const failure = new Error('extend failed');
        const extend = t.mock.method(lock, 'extendLock', () => Promise.reject(failure));
        const reason = await lock.withLock(
            id,
            100,
            0,
            async (held, signal) => {
                await once(signal, 'abort');
                // no further attempts once the lock is considered lost
                await sleep(200);
                return signal.reason;
            },
            { extend: true }
        );
        assert.strictEqual(reason.code, 'ELOCKLOST');
        assert.strictEqual(reason.cause, failure);
        assert.strictEqual(extend.mock.callCount(), 1);
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });

    it('should wait for an extension in flight before releasing', TEST_OPTS, async t => {
        const id = nextId();
        const order: string[] = [];
        const original = lock.extendLock.bind(lock);
        t.mock.method(lock, 'extendLock', async (held: any, ttl: number) => {
            order.push('extend start');
            await sleep(100);
            const result = await original(held, ttl);
            order.push('extend end');
            return result;
        });
        const release = lock.releaseLock.bind(lock);
        t.mock.method(lock, 'releaseLock', (held: any) => {
            order.push('release');
            return release(held);
        });
        // the function ends while the first extension is still running
        await lock.withLock(id, 100, 0, () => sleep(80), { extend: true });
        assert.deepStrictEqual(order, ['extend start', 'extend end', 'release']);
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });

    it('should not let a failed release change the outcome', TEST_OPTS, async t => {
        const failing = makeLock({ redis, namespace });
        const failure = new Error('release failed');
        t.mock.method(failing, 'releaseLock', () => Promise.reject(failure));

        // without a listener the failure is dropped
        assert.strictEqual(await failing.withLock(nextId(), 1000, 0, () => 'ok'), 'ok');

        const emitted: Error[] = [];
        failing.on('error', err => emitted.push(err));
        assert.strictEqual(await failing.withLock(nextId(), 1000, 0, () => 'still ok'), 'still ok');
        const own = new Error('own');
        assert.strictEqual(
            await rejection(
                failing.withLock(nextId(), 1000, 0, () => {
                    throw own;
                })
            ),
            own
        );
        assert.deepStrictEqual(emitted, [failure, failure]);
    });

    it(`should never let concurrent callers overlap (seed ${FUZZ_SEED})`, { timeout: 60 * 1000 }, async () => {
        const random = createRandom(FUZZ_SEED + 7);
        const id = nextId();
        const locks = Array.from({ length: 3 }, () => makeLock({ redis: REDIS_STANDALONE_CONFIG, namespace }));
        // let the subscribers come up so waiters are woken by release notifications
        await sleep(100);

        const callers = Math.max(12, Math.min(60, Math.round(FUZZ_ITERATIONS / 5)));
        // drawn up front so the plan does not depend on scheduling
        const plan = Array.from({ length: callers }, (_, caller) => {
            // with extension on the TTL is often shorter than the hold, so the lock only stays
            // exclusive because it is extended
            const extend = random.chance(0.5);
            return {
                caller,
                lock: random.pick(locks),
                start: random.int(0, 50),
                hold: extend ? random.int(0, 150) : random.int(0, 30),
                extend,
                ttl: extend ? random.int(60, 120) : 5000,
                fail: random.chance(0.2)
            };
        });

        let inside = 0;
        const completed: number[] = [];
        const results = await Promise.allSettled(
            plan.map(async step => {
                await sleep(step.start);
                return step.lock.withLock(
                    id,
                    step.ttl,
                    20 * 1000,
                    async (held, signal) => {
                        assert.strictEqual(inside, 0, `caller ${step.caller} entered while another held the lock`);
                        inside++;
                        try {
                            await sleep(step.hold);
                            assert.strictEqual(signal.aborted, false, `caller ${step.caller} lost its lock`);
                            assert.strictEqual(Number(await redis.hget(lockKey(id), 'index')), held.index);
                            if (step.fail) {
                                throw new Error(`planned failure ${step.caller}`);
                            }
                            completed.push(step.caller);
                            return step.caller;
                        } finally {
                            inside--;
                        }
                    },
                    { extend: step.extend }
                );
            })
        );

        results.forEach((result, i) => {
            const step = plan[i]!;
            if (step.fail) {
                assert.strictEqual(result.status, 'rejected', `caller ${i}`);
                assert.match(String((result as PromiseRejectedResult).reason?.message), /planned failure/, `caller ${i}`);
            } else {
                assert.deepStrictEqual(result, { status: 'fulfilled', value: step.caller }, `caller ${i}`);
            }
        });
        assert.strictEqual(completed.length, plan.filter(step => !step.fail).length);
        assert.strictEqual(await redis.exists(lockKey(id)), 0);
    });
});
