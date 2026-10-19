import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import Lock from '../../src/ioredfour.js';
import type { LockOptions } from '../../src/ioredfour.js';

export const REDIS_STANDALONE_CONFIG = process.env.REDIS_STANDALONE_URL || 'redis://localhost:6379/11';
// Comma-separated host:port list, matching what scripts/redis-cluster.sh starts by default
export const REDIS_CLUSTER_NODES = (process.env.REDIS_CLUSTER_NODES || '127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102').split(',').map(node => {
    const [host, port] = node.trim().split(':');
    return { host: host as string, port: Number(port) };
});
const TEST_TARGET = process.env.TEST_TARGET || 'standalone';
export const RUN_STANDALONE = TEST_TARGET === 'standalone' || TEST_TARGET === 'all';
export const RUN_CLUSTER = TEST_TARGET === 'cluster' || TEST_TARGET === 'all';
// node:test applies a describe() timeout to the whole suite, so per-test timeouts are passed to each it()
export const TEST_OPTS = { timeout: 10000 };
export const CLUSTER_TEST_OPTS = { timeout: 15000 };
export const describeStandalone = RUN_STANDALONE ? describe : describe.skip;
export const describeCluster = RUN_CLUSTER ? describe : describe.skip;

// Resolves to the rejection reason, or undefined when the promise fulfilled
export const rejection = (p: Promise<unknown>): Promise<any> =>
    p.then(
        () => undefined,
        err => err
    );

// Opens Redis clients and Lock instances for a suite and closes them all in closeAll()
export function connectionTracker() {
    let closers: (() => Promise<unknown>)[] = [];
    return {
        makeRedis(opts?: RedisOptions): Redis {
            // ioredis declares its optional properties without `| undefined`
            const redis = opts ? new Redis(REDIS_STANDALONE_CONFIG, opts as any) : new Redis(REDIS_STANDALONE_CONFIG);
            closers.push(() => redis.quit());
            return redis;
        },
        makeLock(options: LockOptions): Lock {
            const lock = new Lock(options);
            closers.push(() => lock.close());
            return lock;
        },
        async closeAll(): Promise<void> {
            const pending = closers;
            closers = [];
            for (const close of pending) {
                await close();
            }
        }
    };
}

export async function waitFor(check: () => boolean, timeout = 2000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!check()) {
        assert.ok(Date.now() < deadline, 'condition not met in time');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
