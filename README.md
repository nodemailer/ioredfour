## ioredfour

> Originally forked from **[redfour](https://www.npmjs.com/package/redfour)**. Main difference being that redfour uses [node_redis](https://www.npmjs.com/package/redis) + [node-redis-scripty](https://www.npmjs.com/package/node-redis-scripty) while ioredfour uses [ioredis](https://www.npmjs.com/package/ioredis). It also supports Redis Cluster mode.

## Install

```sh
npm install ioredfour
```

ioredfour is written in TypeScript and ships type declarations. It is published as a dual package, both module formats work:

```js
// CommonJS
const Lock = require('ioredfour');
```

```js
// ES modules and TypeScript
import Lock from 'ioredfour';
import type { LockOptions, AcquireResult } from 'ioredfour';
```

Node.js 20 or newer is required.

## Usage example

```js
const Lock = require('ioredfour');

(async () => {
    const testLock = new Lock({
        // Can also be an `Object` of options to pass to `new Redis()`
        // https://www.npmjs.com/package/ioredis#connect-to-redis, or an existing
        // instance of `ioredis` (if you want to reuse one connection, though this
        // module must create a second).
        redis: 'redis://localhost:6379',
        namespace: 'mylock',
        // Don't consider the lock owned until writes have been replicated at least this many times
        minReplications: 1,
        // Wait at most this many milliseconds for replication.
        // Note: lock TTL must be at least 1.5x replicationTimeout.
        replicationTimeout: 500
    });
    const id = Math.random();

    // First, acquire the lock.
    const firstlock = await testLock.acquireLock(id, 60 * 1000 /* Lock expires after 60sec if not released */).catch(e => {
        console.log('error acquiring first lock', e);
    });
    if (!firstlock.success) {
        console.log('lock exists', firstlock);
    } else {
        console.log('lock acquired initially');
    }

    // Another server might be waiting for the lock like this.
    testLock
        .waitAcquireLock(id, 60 * 1000 /* Lock expires after 60sec */, 10 * 1000 /* Wait for lock for up to 10sec */)
        .then(secondlock => {
            if (secondlock.success) {
                console.log('second lock acquired after wait!', secondlock);
            } else {
                console.log('second lock not acquired after wait!', secondlock);
            }
        })
        .catch(e => {
            console.log('error wait acquiring', e);
        });

    // When the original lock is released, `waitAcquireLock` is fired on the other server.
    setTimeout(async () => {
        try {
            await testLock.releaseLock(firstlock);
            console.log('released lock');
        } catch (e) {
            console.log('error releasing', e);
        }
    }, 10 * 1000);
})();
```

## withLock

`withLock(id, ttl, waitTtl, fn, opts?)` covers the usual acquire, work, release sequence. It waits up to `waitTtl` milliseconds for the lock, like `waitAcquireLock` (`0` or `undefined` waits indefinitely), calls `fn(lock, signal)` while holding it and always releases the lock afterwards, whether `fn` resolved or threw. It resolves to what `fn` returns and rejects with what `fn` throws.

With `{ wait: false }` the lock is tried once, as `acquireLock` does, and `waitTtl` is ignored.

When the lock is not obtained, `fn` is not called and `withLock` rejects with a `Lock.LockError` whose `code` is `'ELOCKNOTACQUIRED'`. The error carries the lock `id`, `ttl` (the remaining TTL of the current holder's lock, `0` if unknown), `index` (`-1`) and `replicationFailure` (`true` when the lock was acquired but failed the `minReplications` check). A Redis error while acquiring and an invalid TTL reject with that error instead, as `waitAcquireLock` does.

With `{ extend: true }` the lock is extended to the full `ttl` every `ttl / 2` milliseconds while `fn` runs, so `ttl` only has to cover a stalled process, not the whole job. Extending stops when `fn` settles, and an extension still in flight finishes before the lock is released. If an extension fails (the lock expired and someone else took it, or Redis returned an error), extending stops and `signal` is aborted with a `Lock.LockError` (`code: 'ELOCKLOST'`) as `signal.reason`, its `cause` being the `extendLock` result or the Redis error. `fn` should then stop as soon as it can, the lock may already belong to someone else. Without `extend` the signal is never aborted.

A failed release does not change what `withLock` resolves or rejects with, the lock expires after its TTL anyway. The release error is emitted as an `error` event when a listener is attached.

```js
const Lock = require('ioredfour');
const lock = new Lock({ redis: 'redis://localhost:6379', namespace: 'jobs' });

try {
    const result = await lock.withLock(
        'renew:account-1',
        60 * 1000, // lock TTL
        10 * 1000, // wait up to 10 seconds for the lock
        async (held, signal) => {
            // held.index identifies this lock holder
            return await renewSubscription({ signal });
        },
        { extend: true }
    );
} catch (err) {
    if (err instanceof Lock.LockError && err.code === 'ELOCKNOTACQUIRED') {
        // someone else is doing the work
    } else {
        throw err;
    }
}
```

`withLock` has no callback form. The TypeScript declarations export the `LockError`, `LockErrorCode`, `WithLockFunction` and `WithLockOptions` types.

## Errors and shutdown

`Lock` is an `EventEmitter`. Connection errors from the Pub/Sub subscriber connection (and from the command connection when the `Lock` opened it itself) are emitted as `error` events, so attach a listener if you want to log them. Without a listener they are dropped instead of being printed by ioredis.

If the release channel subscription is refused, for example a Redis ACL user without channel permissions (`NOPERM`), the refusal is emitted as an `error` event and the lock keeps working: waiters poll for the lock about once a second instead of waiting for a release notification.

Lock TTLs must be positive integers in milliseconds, at most 999999999999999 (15 digits). `acquireLock`, `extendLock` and `waitAcquireLock` reject any other value with a `TypeError`.

`releaseLock` and `extendLock` only act on a lock while it is still held with the index the lock object carries. `releaseLock` resolves to `{ success, result, index }`, where `result` is `'released'`, `'expired'` (the lock was already gone, `success` is still `true`) or `'conflict'` (someone else holds the lock now). `extendLock` resolves to `{ success, index, ttl }`, with `index` and `ttl` `undefined` when the lock was not extended.

Waiters in `waitAcquireLock` wake up when a release notification arrives over Pub/Sub, and otherwise when the current holder's TTL runs out. Notifications are not queued, so after the subscriber connection reconnects every waiter retries at once instead of sleeping out the TTL of a lock that may have been released in the meantime.

Call `close()` to shut the lock down. It closes the subscriber connection, and the command connection too when the `Lock` created it from a connection string or options object. A Redis instance you passed in is left open.

```js
lock.on('error', err => console.error('lock connection error', err));

// on shutdown
await lock.close();
```

## Redis Cluster mode

`Lock` can also run against Redis Cluster.

```js
const Lock = require('ioredfour');

const lock = new Lock({
    namespace: 'mylock',
    cluster: [
        { host: '127.0.0.1', port: 7000 },
        { host: '127.0.0.1', port: 7001 }
    ],
    // Optional ioredis Cluster options:
    // https://github.com/redis/ioredis#cluster
    clusterOptions: {
        redisOptions: {
            password: process.env.REDIS_PASSWORD
        }
    }
});
```

Using an existing `ioredis` cluster connection:

```js
const Redis = require('ioredis');
const Lock = require('ioredfour');

const cluster = new Redis.Cluster([
    { host: '127.0.0.1', port: 7000 },
    { host: '127.0.0.1', port: 7001 },
    { host: '127.0.0.1', port: 7002 }
]);

const lock = new Lock({
    // `redisConnection` is also supported as an alias:
    // redisConnection: cluster,
    redis: cluster,
    namespace: 'mylock'
});
```

Supported cluster configuration forms:

- `cluster: true` with `redis` or `redisConnection` set to cluster startup nodes array
- `cluster: [{ host, port }, ...]`
- `cluster: { nodes: [...], options: {...} }`
- Existing cluster client via `redis` or `redisConnection`

When cluster mode is enabled, lock keys are automatically hash-tagged internally so Lua script keys are routed to the same Redis Cluster slot.
Cluster mode also uses sharded pub/sub (`SSUBSCRIBE` and `SPUBLISH`) for release notifications.
Sharded pub/sub requires Redis 7+.
If sharded pub/sub commands are unavailable, lock initialization fails with a compatibility error.

## Contributing

We welcome pull requests! Please lint your code (`npm run lint`) and format it (`npm run format`).

The library is written in TypeScript under `src/` and built into `dist/esm` and `dist/cjs` with `npm run build`. Tests need a running Redis:

- `npm test` runs the standalone Redis tests (`REDIS_STANDALONE_URL`, default `redis://localhost:6379/11`), including the package tests of the built output
- `npm run cluster:up` starts a local Redis Cluster in Docker (three masters with one replica each, `127.0.0.1:7100-7105`), `npm run test:cluster` runs the cluster tests against it, `npm run test:all` runs both suites and `npm run cluster:down` removes it
- `npm run test:coverage` runs both suites with coverage, so it needs the cluster too
- `npm run test:cjs` loads the CommonJS build with `require(esm)` turned off, `npm run test:pkg` bundles it into a `@yao-pkg/pkg` binary and runs it
- `npm run test:mutation` runs the mutation tests (slow, not part of CI)

## Release History

See [CHANGELOG.md](CHANGELOG.md).

## Etymology

Shortened (and easier to pronounce) version of "Redis Semaphore"
