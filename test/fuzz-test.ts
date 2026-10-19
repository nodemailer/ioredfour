import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import type { AcquireResult, LockHandle, LockId } from '../src/ioredfour.js';
import { MAX_TTL } from '../src/scripts.js';
import { REDIS_STANDALONE_CONFIG, connectionTracker, describeStandalone, rejection } from './fixtures/redis.js';
import { FUZZ_ITERATIONS, FUZZ_SEED, createRandom } from './fixtures/fuzz.js';
import type { Random } from './fixtures/fuzz.js';

// Generated tests. The Lua argument fuzz feeds the scripts TTL strings directly, past the
// JavaScript validation, and checks them against a one-line oracle. The model test runs random
// operation sequences over several Lock instances and compares every result and the state left in
// Redis with a plain in-memory model of what a lock should do.

const FUZZ_OPTS = { timeout: 60 * 1000 };

const ttlStringOracle = (ttl: string) => /^[1-9][0-9]*$/.test(ttl) && ttl.length <= String(MAX_TTL).length;

function randomTtlString(random: Random): string {
    switch (random.int(0, 5)) {
        case 0:
            // plain digits, sometimes too long or with a leading zero
            return String(random.int(0, 9)) + Array.from({ length: random.int(0, 20) }, () => random.int(0, 9)).join('');
        case 1:
            return String(random.int(1, 1e9));
        case 2:
            return String(random.int(1, 9)).padEnd(random.int(14, 17), '9');
        case 3:
            return random.pick(['', ' ', '-1', '+1', '0', '00', '1.0', '1e3', '0x1f', 'inf', 'nan', '1 ', ' 1', '1\n', '\u0663', '1_000']);
        default: {
            // random characters from an alphabet tonumber() and PEXPIRE care about
            const alphabet = '0123456789.eExX+- \t\nabcdef';
            return Array.from({ length: random.int(1, 18) }, () => alphabet[random.int(0, alphabet.length - 1)]).join('');
        }
    }
}

describeStandalone('fuzz', () => {
    const { makeRedis, makeLock, closeAll } = connectionTracker();
    let redis: Redis;

    before(() => {
        redis = makeRedis();
    });

    after(closeAll);

    it(`should accept exactly the TTL strings of plain decimal digits (seed ${FUZZ_SEED})`, FUZZ_OPTS, async () => {
        const random = createRandom(FUZZ_SEED);
        const lock = makeLock({ redis, namespace: `fuzzTtl:${FUZZ_SEED}` });
        const id = `TEST:${Date.now()}:fuzz-ttl`;
        const key = lock._lockKey(id);
        const acquire = (ttl: string) => (redis as any)[lock.fn('acquireLock')](key, lock._indexKey(), ttl);
        const extend = (index: number, ttl: string) => (redis as any)[lock.fn('extendLock')](key, index, ttl);

        for (let i = 0; i < FUZZ_ITERATIONS; i++) {
            const ttl = randomTtlString(random);
            const label = `seed ${FUZZ_SEED} case ${i} ttl ${JSON.stringify(ttl)}`;
            const accepted = ttlStringOracle(ttl);

            const acquireError = await rejection(acquire(ttl));
            const pttl = await redis.pttl(key);
            if (accepted) {
                assert.strictEqual(acquireError, undefined, label);
                assert.ok(pttl > 0, `${label}: pttl ${pttl}`);
            } else {
                assert.match(String(acquireError?.message), /positive integer/, label);
                // -2 means no key; -1 would be a lock that never expires
                assert.strictEqual(pttl, -2, label);
            }

            // extend against a held lock: a rejected TTL leaves the old expiry in place
            const held = accepted ? await redis.hget(key, 'index') : (await acquire('60000'))[1];
            const before = await redis.pttl(key);
            const extendError = await rejection(extend(Number(held), ttl));
            const afterExtend = await redis.pttl(key);
            if (accepted) {
                assert.strictEqual(extendError, undefined, label);
                assert.ok(afterExtend > 0, label);
            } else {
                assert.match(String(extendError?.message), /positive integer/, label);
                assert.ok(afterExtend > 0 && afterExtend <= before, label);
            }
            await redis.del(key);
        }
    });

    it(`should match the lock model over random operation sequences (seed ${FUZZ_SEED})`, FUZZ_OPTS, async () => {
        const random = createRandom(FUZZ_SEED + 1);
        const namespace = `fuzzModel:${FUZZ_SEED}:${Date.now()}`;
        // separate connections, the way separate processes would hold them
        const instances = [0, 1, 2].map(() => makeLock({ redis: REDIS_STANDALONE_CONFIG, namespace }));
        // 7 and '7' name the same lock
        const ids: LockId[] = [`TEST:${Date.now()}:a`, `TEST:${Date.now()}:b`, 7, '7'];
        const model = new Map<string, number>(); // String(id) -> index of the current holder
        const handles: LockHandle[] = [];
        let lastIndex = 0;

        const invalidTtls = [0, -1, 1.5, NaN, Infinity, MAX_TTL + 1, '1000', null, undefined];
        const anyLock = () => random.pick(instances);
        const anyHandle = (): LockHandle =>
            handles.length && random.chance(0.8) ? random.pick(handles) : { id: random.pick(ids), index: random.pick([-1, 0, lastIndex + 1, lastIndex]) };
        const validTtl = () => random.pick([60 * 1000, 10 * 60 * 1000, random.int(60 * 1000, MAX_TTL)]);

        const checkAcquired = (label: string, result: AcquireResult, id: LockId, ttl: number) => {
            if (!model.has(String(id))) {
                assert.strictEqual(result.success, true, label);
                assert.ok(result.index > lastIndex, `${label}: index ${result.index} after ${lastIndex}`);
                assert.strictEqual(result.ttl, ttl, label);
                lastIndex = result.index;
                model.set(String(id), result.index);
                handles.push({ id: result.id, index: result.index });
            } else {
                assert.strictEqual(result.success, false, label);
                assert.strictEqual(result.index, -1, label);
                assert.ok(result.ttl > 0, label);
            }
        };

        for (let i = 0; i < FUZZ_ITERATIONS; i++) {
            const lock = anyLock();
            const op = random.int(0, 9);
            const label = `seed ${FUZZ_SEED} case ${i} op ${op}`;

            if (op <= 2) {
                const id = random.pick(ids);
                const ttl = validTtl();
                checkAcquired(label, await lock.acquireLock(id, ttl), id, ttl);
            } else if (op <= 4) {
                const handle = anyHandle();
                const holder = model.get(String(handle.id));
                const result = await lock.releaseLock(handle);
                if (holder === undefined) {
                    assert.deepStrictEqual(result, { id: handle.id, success: true, result: 'expired', index: 0 }, label);
                } else if (holder === handle.index) {
                    assert.deepStrictEqual(result, { id: handle.id, success: true, result: 'released', index: holder }, label);
                    model.delete(String(handle.id));
                } else {
                    assert.deepStrictEqual(result, { id: handle.id, success: false, result: 'conflict', index: holder }, label);
                }
            } else if (op <= 6) {
                const handle = anyHandle();
                const ttl = validTtl();
                const holds = model.get(String(handle.id)) === handle.index;
                const expected = holds
                    ? { id: handle.id, success: true, index: handle.index, ttl }
                    : { id: handle.id, success: false, index: undefined, ttl: undefined };
                assert.deepStrictEqual(await lock.extendLock(handle, ttl), expected, label);
            } else if (op === 7) {
                // the lock expires
                const id = random.pick(ids);
                await redis.del(lock._lockKey(id));
                model.delete(String(id));
            } else if (op === 8) {
                const ttl = random.pick(invalidTtls) as number;
                const error = random.chance(0.5)
                    ? await rejection(lock.acquireLock(random.pick(ids), ttl))
                    : await rejection(lock.extendLock(anyHandle(), ttl));
                assert.ok(error instanceof TypeError, `${label}: ttl ${String(ttl)}`);
            } else {
                // a short wait gives up on a held lock and takes a free one at once
                const id = random.pick(ids);
                const ttl = validTtl();
                checkAcquired(label, await lock.waitAcquireLock(id, ttl, random.int(1, 30)), id, ttl);
            }

            for (const id of new Set(ids.map(String))) {
                const pttl = await redis.pttl(instances[0]!._lockKey(id));
                if (model.has(id)) {
                    assert.ok(pttl > 0, `${label}: ${id} is held but has pttl ${pttl}`);
                    assert.strictEqual(Number(await redis.hget(instances[0]!._lockKey(id), 'index')), model.get(id), label);
                } else {
                    assert.strictEqual(pttl, -2, `${label}: ${id} should be free`);
                }
            }
        }

        for (const [id, index] of model) {
            await instances[0]!.releaseLock({ id, index });
        }
    });
});
