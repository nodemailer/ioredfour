import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import type Lock from '../src/ioredfour.js';
import { REDIS_STANDALONE_CONFIG, connectionTracker, describeStandalone } from './fixtures/redis.js';
import { FUZZ_SEED, createRandom } from './fixtures/fuzz.js';

// Many waiters on separate connections compete for one lock. Checks mutual exclusion (no two
// holders inside the critical section at once), liveness (every waiter gets the lock in the end,
// through release notifications or the TTL of a holder that crashed without releasing) and that
// lock indexes only grow.

const INSTANCES = 4;
const WORKERS_PER_INSTANCE = 4;
const ROUNDS = 5;
// TTL of a holder that "crashes" and never releases, waiters get the lock once it expires
const CRASHED_TTL = 60;

describeStandalone('contention', () => {
    const { makeLock, closeAll } = connectionTracker();

    after(closeAll);

    it(`should hand the lock to one holder at a time (seed ${FUZZ_SEED})`, { timeout: 60 * 1000 }, async () => {
        const random = createRandom(FUZZ_SEED + 2);
        const namespace = `contention:${FUZZ_SEED}:${Date.now()}`;
        const id = 'shared';
        const locks = Array.from({ length: INSTANCES }, () => makeLock({ redis: REDIS_STANDALONE_CONFIG, namespace }));
        // Waiters need the release channel, as a waiter normally would in a long-running process
        await new Promise(resolve => setTimeout(resolve, 100));

        let inside = 0;
        let sections = 0;
        let crashes = 0;
        const indexes: number[] = [];
        // Delays and crashes drawn up front so that the sequence does not depend on scheduling
        const plan = Array.from({ length: INSTANCES * WORKERS_PER_INSTANCE * ROUNDS }, () => ({
            hold: random.int(0, 5),
            crash: random.chance(0.1)
        }));

        const worker = async (lock: Lock, worker: number) => {
            for (let round = 0; round < ROUNDS; round++) {
                const step = plan[worker * ROUNDS + round]!;
                const acquired = await lock.waitAcquireLock(id, step.crash ? CRASHED_TTL : 5000, 20 * 1000);
                assert.strictEqual(acquired.success, true, `worker ${worker} round ${round}`);

                assert.strictEqual(inside, 0, 'two holders inside the critical section');
                inside++;
                indexes.push(acquired.index);
                await new Promise(resolve => setTimeout(resolve, step.hold));
                inside--;
                sections++;

                if (step.crash) {
                    // leave without releasing, the lock expires after CRASHED_TTL
                    crashes++;
                    continue;
                }
                const released = await lock.releaseLock(acquired);
                assert.strictEqual(released.result, 'released');
            }
        };

        const start = Date.now();
        await Promise.all(locks.flatMap((lock, i) => Array.from({ length: WORKERS_PER_INSTANCE }, (_, j) => worker(lock, i * WORKERS_PER_INSTANCE + j))));

        assert.strictEqual(sections, plan.length);
        assert.deepStrictEqual(
            indexes,
            [...indexes].sort((a, b) => a - b)
        );
        assert.strictEqual(new Set(indexes).size, indexes.length);
        // Released locks are handed over through notifications: the run takes about as long as the
        // crashed holders' TTLs plus the time spent inside, not the 5s TTL of the others
        assert.ok(Date.now() - start < 10 * 1000 + crashes * CRASHED_TTL, `took ${Date.now() - start}ms`);
    });
});
