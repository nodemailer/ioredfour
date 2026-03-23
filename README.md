## ioredfour

> Originally forked from **[redfour](https://www.npmjs.com/package/redfour)**. Main difference being that redfour uses [node_redis](https://www.npmjs.com/package/redis) + [node-redis-scripty](https://www.npmjs.com/package/node-redis-scripty) while ioredfour uses [ioredis](https://www.npmjs.com/package/ioredis). It also supports Redis Cluster mode.

## Install

```sh
npm install ioredfour
```

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

We welcome pull requests! Please lint your code.

Test targets:

- `npm test` runs standalone Redis tests only
- `npm run test:cluster` runs Redis Cluster tests only
- `npm run test:all` runs both suites

Standalone tests use `REDIS_STANDALONE_URL` (default: `redis://localhost:6379/11`) and should point to a non-cluster Redis instance.
Cluster tests use nodes `localhost:7000`, `localhost:7001`, `localhost:7002`.

## Release History

See [CHANGELOG.md](CHANGELOG.md).

## Etymology

Shortened (and easier to pronounce) version of "Redis Semaphore"
