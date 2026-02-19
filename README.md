## ioredfour

> Originally forked from **[redfour](https://www.npmjs.com/package/redfour)**. Main difference being that redfour uses [node_redis](https://www.npmjs.com/package/redis) + [node-redis-scripty](https://www.npmjs.com/package/node-redis-scripty) while ioredfour uses [ioredis](https://www.npmjs.com/package/ioredis).

## Install

or

```sh
npm install ioredfour --save
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
        // Wait at most this many miliseconds for replication
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

Supported cluster configuration forms:

-   `cluster: true` with `redis` set to cluster startup nodes array
-   `cluster: [{ host, port }, ...]`
-   `cluster: { nodes: [...], options: {...} }`
-   Existing cluster client via `redis: existingClusterClient`

When cluster mode is enabled, lock keys are automatically hash-tagged internally so Lua script keys are routed to the same Redis Cluster slot.
Cluster mode also uses sharded pub/sub (`SSUBSCRIBE` and `SPUBLISH`) for release notifications.
Sharded pub/sub requires Redis 7+.

## Contributing

We welcome pull requests! Please lint your code.

Test targets:

-   `npm test` runs standalone Redis tests only
-   `npm run test:cluster` runs Redis Cluster tests only
-   `npm run test:all` runs both suites

Standalone tests use `REDIS_STANDALONE_URL` (default: `redis://localhost:6379/11`) and should point to a non-cluster Redis instance.
Cluster tests use nodes `localhost:7000`, `localhost:7001`, `localhost:7002`.

## Release History

-   1.1.0 add Lock.extend, promisified interface, check for replication
-   1.0.2-ioredis Forked from redfour and switch node_redis with ioredis
-   1.0.2 Don't use `instanceof` to determine if the `redis` constructor option is of
    type `redis.RedisClient`.
-   1.0.1 Fix issue where you could only pass in a Redis connection URI.
-   1.0.0 Initial release.

## Etymology

Shortened (and easier to pronouce) version of "Redis Semaphore"
