import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { callbackify } from 'node:util';
import { Cluster, Redis } from 'ioredis';
import type { ClusterNode, ClusterOptions, RedisOptions } from 'ioredis';
import { MAX_TTL, acquireScript, extendScript, releaseScript } from './scripts.js';

// How often waiters retry when the release channel subscription was refused
const POLL_INTERVAL_WITHOUT_PUBSUB = 1000;

// setTimeout() fires after 1ms for any longer delay
const MAX_TIMER_DELAY = 2 ** 31 - 1;

const isValidTtl = (ttl: unknown): ttl is number => Number.isInteger(ttl) && (ttl as number) > 0 && (ttl as number) <= MAX_TTL;

const invalidTtl = (ttl: unknown) => Promise.reject(new TypeError(`Lock TTL must be a positive integer (ms) up to ${MAX_TTL}, got ${String(ttl)}`));

const invalidLock = (lock: unknown) => Promise.reject(new TypeError(`Expected a lock object returned by acquireLock or waitAcquireLock, got ${String(lock)}`));

const isLockHandle = (lock: unknown): lock is LockHandle =>
    typeof lock === 'object' &&
    lock !== null &&
    ['string', 'number'].includes(typeof (lock as LockHandle).id) &&
    ['string', 'number'].includes(typeof (lock as LockHandle).index);

/** Identifies a lock. Any value with a consistent string form works, the lock key is built from `String(id)`. */
export type LockId = string | number;

/** A Redis client the Lock can share: a standalone `Redis` or a `Cluster` instance of ioredis. */
export type RedisClient = Redis | Cluster;

export interface ClusterConfig {
    /** Cluster startup nodes */
    nodes?: ClusterNode[] | undefined;
    /** Alias for `nodes` */
    startupNodes?: ClusterNode[] | undefined;
    /** Options for `new Redis.Cluster(nodes, options)` */
    options?: ClusterOptions | undefined;
}

export interface LockOptions {
    /**
     * Redis connection string, options to pass to `new Redis()`, an existing `Redis`/`Redis.Cluster`
     * instance, or the cluster startup nodes when `cluster` is `true`.
     */
    redis?: string | RedisOptions | RedisClient | ClusterNode[] | undefined;
    /** Alias for `redis`. If both are provided, `redisConnection` takes precedence. */
    redisConnection?: string | RedisOptions | RedisClient | ClusterNode[] | undefined;
    /**
     * Cluster mode config. Use one of:
     * - `true` with `redis` or `redisConnection` as startup nodes array
     * - startup nodes array directly
     * - `{ nodes, options }` object for `new Redis.Cluster(nodes, options)`
     */
    cluster?: boolean | ClusterNode[] | ClusterConfig | undefined;
    /** ioredis Cluster options, used when `cluster` is `true` or a startup nodes array */
    clusterOptions?: ClusterOptions | undefined;
    /** Prefix for all Redis keys and channels used by this lock. Defaults to `lock`. */
    namespace?: string | undefined;
    /** A lock is only considered acquired once the write has been replicated at least this many times */
    minReplications?: number | undefined;
    /**
     * Wait at most this many milliseconds for replication, defaults to 500. Lock TTLs must be at
     * least 1.5x this value when `minReplications` is set.
     */
    replicationTimeout?: number | undefined;
}

/** The part of a lock that `releaseLock` and `extendLock` need */
export interface LockHandle {
    id: LockId;
    index: number;
}

export interface AcquireResult extends LockHandle {
    /** `true` if the lock was acquired */
    success: boolean;
    /**
     * Lock index, a shared incrementing number that keeps stale holders from releasing or
     * extending newer locks for the same id. `-1` if the lock was not acquired.
     */
    index: number;
    /** TTL of the acquired lock, or the remaining TTL of the current holder's lock (ms) */
    ttl: number;
    /** Set when the lock was acquired but not replicated to `minReplications` replicas in time and was released again */
    replicationFailure?: boolean | undefined;
}

export interface ReleaseResult {
    id: LockId;
    /** `true` if the lock was released or did not exist anymore */
    success: boolean;
    result: 'released' | 'expired' | 'conflict';
    /** Index of the lock that was released or is held by someone else, `0` if it had expired */
    index: number;
}

export interface ExtendResult {
    id: LockId;
    /** `true` if the lock was still held with the given index and its TTL was reset */
    success: boolean;
    /** The lock index, `undefined` if the lock was not extended */
    index: number | undefined;
    /** The new TTL (ms), `undefined` if the lock was not extended */
    ttl: number | undefined;
}

export type LockCallback<T> = (err: Error | null, result: T) => void;

/**
 * `ELOCKNOTACQUIRED`: `withLock` could not get the lock within `waitTtl`.
 * `ELOCKLOST`: an automatic extension of a `withLock` lock failed, used as the abort reason.
 */
export type LockErrorCode = 'ELOCKNOTACQUIRED' | 'ELOCKLOST';

/** Thrown by `withLock` when the lock is not obtained, and the abort reason when an extension fails. Available as `Lock.LockError`. */
class LockError extends Error {
    code: LockErrorCode;
    /** The lock id */
    id: LockId;
    /** Index of the lock that was lost, `-1` if it was never acquired */
    index: number;
    /** `ELOCKNOTACQUIRED`: remaining TTL of the current holder's lock (ms), `0` if unknown */
    ttl: number;
    /** `ELOCKNOTACQUIRED`: set when the lock was acquired but failed the `minReplications` check */
    replicationFailure: boolean;

    constructor(
        message: string,
        code: LockErrorCode,
        details: { id: LockId; index: number; ttl: number; replicationFailure?: boolean | undefined; cause?: unknown }
    ) {
        super(message, 'cause' in details ? { cause: details.cause } : undefined);
        this.name = 'LockError';
        this.code = code;
        this.id = details.id;
        this.index = details.index;
        this.ttl = details.ttl;
        this.replicationFailure = !!details.replicationFailure;
    }
}

export type { LockError };

export interface WithLockOptions {
    /**
     * Extend the lock to the full `ttl` every `ttl / 2` ms while the function runs. When an
     * extension fails, extending stops and the signal passed to the function is aborted with a
     * `LockError` (`ELOCKLOST`) as its reason. Defaults to `false`.
     */
    extend?: boolean | undefined;
}

/**
 * The function `withLock` runs while holding the lock. `signal` is aborted only when an automatic
 * extension fails (`extend: true`), meaning the lock may be held by someone else by now.
 */
export type WithLockFunction<T> = (lock: AcquireResult, signal: AbortSignal) => T | PromiseLike<T>;

type ScriptReply = [number, number, number];
type ReleaseReply = [number, ReleaseResult['result'], number];

/**
 * A Redis based lock (binary semaphore). Emits `error` for connection errors of the connections
 * it manages, but only when an `error` listener is attached.
 */
class Lock extends EventEmitter {
    /** The error class `withLock` throws when the lock is not obtained */
    declare static LockError: typeof LockError;

    /** @internal */
    _namespace: string;
    /** @internal */
    _nsHash: string;
    /** @internal */
    _clusterHashTag: string;
    /** @internal */
    _releaseChannel: string;
    /** @internal */
    _minReplications: number;
    /** @internal */
    _replicationTimeout: number;
    /** @internal */
    _clusterMode: boolean;
    /** @internal Connections this instance opened itself are closed by close(); a caller-provided one is not */
    _ownsConnection: boolean;
    /** @internal */
    _redisConnection: RedisClient;
    /** @internal */
    _redisSubscriber: RedisClient;
    /** @internal Waiters, keyed by lock key */
    _subscribers: EventEmitter;
    /** @internal Set when the release channel subscription was refused */
    _pubsubRefused: boolean;
    /** @internal Set once the release channel subscription is active */
    _pubsubSubscribed: boolean;

    /**
     * @param options Connection and lock settings. A connection is required: `redis`,
     *   `redisConnection` or `cluster`.
     */
    constructor(options?: LockOptions) {
        super();
        options = options || {};
        const redisOption = options.redisConnection || options.redis;
        this._namespace = options.namespace || 'lock';
        this._nsHash = createHash('sha256').update(this._namespace).digest('hex').slice(-12);
        this._clusterHashTag = `{ior4_${this._nsHash}}`;
        this._releaseChannel = `${this._namespace}-release`;

        this._minReplications = options.minReplications || 0;
        this._replicationTimeout = options.replicationTimeout || 500;

        // Create Redis connection for issuing normal commands as well as one for
        // the subscription, since a Redis connection with subscribers is not allowed
        // to issue commands.
        assert(redisOption || options.cluster, 'Must provide Redis configuration or cluster configuration (`redis`, `redisConnection`, or `cluster`).');

        this._clusterMode = !!options.cluster;
        this._ownsConnection = false;

        if (redisOption && typeof (redisOption as RedisClient).duplicate === 'function') {
            const client = redisOption as RedisClient;
            this._redisConnection = client;
            this._clusterMode = this._clusterMode || this._isClusterClient(client);
            if (this._clusterMode) {
                this._redisSubscriber = (client as Cluster).duplicate([], {
                    shardedSubscribers: true
                });
            } else {
                this._redisSubscriber = (client as Redis).duplicate();
            }
            assert(this._redisSubscriber, 'Provided Redis client must support duplicate()');
        } else if (options.cluster) {
            const { nodes, options: resolvedOptions } = this._resolveClusterConfig(options, redisOption);
            // ioredis declares its own optional properties without `| undefined`
            const clusterOptions = resolvedOptions as ConstructorParameters<typeof Cluster>[1];
            this._redisConnection = new Cluster(nodes, clusterOptions);
            this._redisSubscriber = new Cluster(nodes, clusterOptions);
            this._clusterMode = true;
            this._ownsConnection = true;
        } else {
            // We assume `redis` is a connection string or options object.
            this._redisConnection = new Redis(redisOption as string);
            this._redisSubscriber = new Redis(redisOption as string);
            this._ownsConnection = true;
        }

        // Without an 'error' listener ioredis prints connection errors straight to stderr.
        // Forward them to the Lock instead, but only when someone listens: an 'error' event
        // with no listener would throw.
        const forwardError = (err: Error) => {
            if (this.listenerCount('error')) {
                this.emit('error', err);
            }
        };
        this._redisSubscriber.on('error', forwardError);
        if (this._ownsConnection) {
            this._redisConnection.on('error', forwardError);
        }

        if (this._clusterMode) {
            // For SPUBLISH in Lua scripts, shard channel must resolve to the same slot as lock keys.
            this._releaseChannel = `${this._namespace}:${this._clusterHashTag}-release`;
            assert(
                typeof this._redisSubscriber.ssubscribe === 'function' && typeof this._redisConnection.spublish === 'function',
                'Cluster mode requires Redis 7.0+ sharded pub/sub support (SSUBSCRIBE/SPUBLISH).'
            );
        }

        // Create event handler to register waiting locks
        this._subscribers = new EventEmitter();
        this._subscribers.setMaxListeners(Infinity);

        // Whenever a lock is released it is published to the namespaced '-release' channel
        // using the lock key as the message.
        const messageEvent = this._clusterMode ? 'smessage' : 'message';
        // Set when the subscription was refused, for example NOPERM from a Redis ACL user without
        // channel permissions. Locks keep working without release notifications, waiters just poll.
        this._pubsubRefused = false;
        this._pubsubSubscribed = false;
        const subscribe = () => {
            const subscribed = this._clusterMode
                ? this._redisSubscriber.ssubscribe(this._releaseChannel)
                : this._redisSubscriber.subscribe(this._releaseChannel);
            subscribed.then(
                () => {
                    this._pubsubSubscribed = true;
                    this._pubsubRefused = false;
                    // A release published while the subscription was not active was not delivered
                    this._wakeWaiters();
                },
                (err: Error) => {
                    this._pubsubRefused = true;
                    forwardError(err);
                }
            );
        };
        subscribe();
        // Releases published while the subscriber was disconnected were lost, so every waiter
        // retries once the subscription is back instead of sleeping out the lock TTL
        if (this._clusterMode) {
            // ioredis has sent the SSUBSCRIBE again by now. Subscribing once more would add the
            // channel to its list twice
            this._redisSubscriber.on('subscribersReady', () => {
                if (this._pubsubSubscribed) {
                    this._wakeWaiters();
                }
            });
        } else {
            // 'ready' is emitted before ioredis resubscribes, so subscribe again (a no-op for
            // Redis) and wake the waiters on its reply, when the subscription is confirmed
            this._redisSubscriber.on('ready', () => {
                if (this._pubsubSubscribed || this._pubsubRefused) {
                    subscribe();
                }
            });
        }
        this._redisSubscriber.on(messageEvent, (channel: string, message: string) => {
            if (channel !== this._releaseChannel || !this._subscribers.listenerCount(message)) {
                // just ignore, nothing to do here
                return;
            }

            // Notify all waiting instances about the released lock
            this._subscribers.emit(message);
        });

        // Define scripted commands
        this._defineCommand('acquireLock', 2, acquireScript());
        this._defineCommand('extendLock', 1, extendScript());
        this._defineCommand('releaseLock', 1, releaseScript(this._clusterMode));
    }

    // ioredis defines lua commands as globals so we might get clashes with other modules if we use names like "releaseLock" etc.
    // so we use namespace specific command names instead.
    /** @internal */
    fn(name: string): string {
        return `ior4_${this._nsHash}_${name}`;
    }

    /** @internal */
    _defineCommand(name: string, numberOfKeys: number, lua: string): void {
        if (typeof (this._redisConnection as any)[this.fn(name)] !== 'function') {
            this._redisConnection.defineCommand(this.fn(name), { numberOfKeys, lua });
        }
    }

    /** @internal Runs one of the scripted commands */
    _command<T>(name: string, ...args: (string | number)[]): Promise<T> {
        return (this._redisConnection as any)[this.fn(name)](...args);
    }

    /** @internal Makes every waiter retry right away */
    _wakeWaiters(): void {
        for (const key of this._subscribers.eventNames()) {
            this._subscribers.emit(key);
        }
    }

    /**
     * Closes the subscriber connection this Lock duplicated or opened, and the command connection
     * when the Lock opened that one too. A connection passed in by the caller is left open.
     */
    close(): Promise<void> {
        const connections = [this._redisSubscriber];
        if (this._ownsConnection) {
            connections.push(this._redisConnection);
        }
        return Promise.all(
            connections.map(
                connection =>
                    new Promise<void>(resolve => {
                        if (connection.status === 'end') {
                            return resolve();
                        }
                        // QUIT resolves on the server's OK, before the socket is gone
                        connection.once('end', resolve);
                        Promise.resolve()
                            .then(() => connection.quit())
                            .catch(() => connection.disconnect());
                    })
            )
        ).then(() => undefined);
    }

    /** @internal */
    _isClusterClient(client: RedisClient): boolean {
        return !!(client as Redis).isCluster;
    }

    /** @internal */
    _resolveClusterConfig(options: LockOptions, redisOption: LockOptions['redis']): { nodes: ClusterNode[]; options: ClusterOptions } {
        const cluster = options.cluster;
        const clusterOptionsSource = cluster && typeof cluster === 'object' && !Array.isArray(cluster) ? cluster.options : options.clusterOptions;

        let nodes: ClusterNode[] | undefined;
        if (Array.isArray(cluster)) {
            nodes = cluster;
        } else if (cluster === true) {
            assert(Array.isArray(redisOption), 'When cluster=true, provide startup nodes array as `redis` or `redisConnection`.');
            nodes = redisOption;
        } else if (cluster && typeof cluster === 'object') {
            nodes = cluster.nodes || cluster.startupNodes;
            assert(Array.isArray(nodes), 'Cluster configuration object must include a nodes array.');
        }

        if (nodes) {
            return { nodes, options: { ...clusterOptionsSource, shardedSubscribers: true } };
        }

        throw new Error('Invalid cluster configuration.');
    }

    /** @internal */
    _lockKey(id: LockId): string {
        if (!this._clusterMode) {
            return `${this._namespace}:${id}`;
        }
        return `${this._namespace}:${this._clusterHashTag}:${id}`;
    }

    /** @internal */
    _indexKey(): string {
        if (!this._clusterMode) {
            return `${this._namespace}index`;
        }
        return `${this._namespace}:${this._clusterHashTag}:index`;
    }

    /**
     * Acquire a lock for a specific ID value. Does not wait if the lock is already held.
     *
     * Lock index is a shared incrementing number (signed 64bit) that should ensure rogue
     * lock holders would not be able to mess with newer locks for the same resource.
     *
     * @param id Identifies the lock. This is an arbitrary string that should be consistent among
     *    different processes trying to acquire this lock.
     * @param ttl Automatically release lock after TTL (ms). Must be a positive integer
     */
    acquireLock(id: LockId, ttl: number): Promise<AcquireResult>;
    acquireLock(id: LockId, ttl: number, callback: LockCallback<AcquireResult>): void;
    acquireLock(id: LockId, ttl: number, callback?: LockCallback<AcquireResult>): Promise<AcquireResult> | void {
        if (arguments.length > 2) {
            return callbackify((i: LockId, t: number) => this.acquireLock(i, t))(id, ttl, callback as LockCallback<AcquireResult>);
        }

        if (!isValidTtl(ttl)) {
            return invalidTtl(ttl);
        }

        if (this._minReplications > 0 && ttl < this._replicationTimeout * 1.5) {
            return Promise.reject(
                new Error(
                    `Lock TTL (${ttl}ms) must be at least 1.5x replicationTimeout (${this._replicationTimeout}ms). Minimum TTL: ${Math.ceil(this._replicationTimeout * 1.5)}ms`
                )
            );
        }

        const lockKey = this._lockKey(id);
        const indexKey = this._indexKey();
        const fnAcquire = this.fn('acquireLock');

        // Maps a Redis eval response array to a lock result object
        const toLockResult = (response: ScriptReply): AcquireResult => ({
            id,
            success: !!response[0],
            index: response[1],
            ttl: response[2]
        });

        if (!this._minReplications) {
            return this._command<ScriptReply>('acquireLock', lockKey, indexKey, ttl).then(toLockResult);
        }

        // Replication path with retry
        const deadline = Date.now() + this._replicationTimeout;
        const RETRY_DELAY = 50;

        const attempt = (): Promise<AcquireResult> => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                return Promise.resolve({
                    id,
                    success: false,
                    replicationFailure: true,
                    index: -1,
                    ttl: 0
                });
            }

            const waitTimeout = Math.min(Math.max(remaining, 1), Math.ceil(this._replicationTimeout / 3));
            const pipeline = (this._redisConnection.pipeline() as any)[fnAcquire](lockKey, indexKey, ttl).wait(this._minReplications, waitTimeout);

            return pipeline.exec().then(([r1, r2]: [[Error | null, ScriptReply], [Error | null, number]]) => {
                const [evalErr, evalResponse] = r1;
                const [repErr, replications] = r2;

                if (evalErr || repErr) {
                    throw evalErr || repErr;
                }

                if (!evalResponse[0]) {
                    return toLockResult(evalResponse);
                }

                if (replications >= this._minReplications) {
                    // Reset TTL to compensate for time spent in WAIT
                    return this._command<ScriptReply>('extendLock', lockKey, evalResponse[1], ttl).then(extendResponse => {
                        if (extendResponse[0]) {
                            return toLockResult(extendResponse);
                        }
                        return { id, success: false, index: evalResponse[1], ttl: 0 };
                    });
                }

                // Replication failed, release and retry with backoff
                const retry = () => new Promise<AcquireResult>(resolve => setTimeout(() => resolve(attempt()), RETRY_DELAY));
                return this._release(id, evalResponse[1]).then(retry, retry);
            });
        };

        return attempt();
    }

    /** @internal */
    _release(id: LockId, index: number): Promise<ReleaseReply> {
        const lockKey = this._lockKey(id);
        // The notification carries the unprefixed key, the same string waiters listen for
        return this._command<ReleaseReply>('releaseLock', lockKey, index, this._releaseChannel, lockKey);
    }

    /**
     * Releases a lock. Operation only succeeds if a correct modification index is provided.
     * If modification index has been changed then it should indicate that the previously held
     * lock was expired in the meantime and someone has already acquired a new lock for the same id.
     * If lock is not released manually then it expires automatically after the ttl
     *
     * @param lock A lock returned by acquireLock or waitAcquireLock
     */
    releaseLock(lock: LockHandle): Promise<ReleaseResult>;
    releaseLock(lock: LockHandle, callback: LockCallback<ReleaseResult>): void;
    releaseLock(lock: LockHandle, callback?: LockCallback<ReleaseResult>): Promise<ReleaseResult> | void {
        if (arguments.length > 1) {
            return callbackify((l: LockHandle) => this.releaseLock(l))(lock, callback as LockCallback<ReleaseResult>);
        }

        if (!isLockHandle(lock)) {
            return invalidLock(lock);
        }

        return this._release(lock.id, lock.index).then(evalResponse => ({
            id: lock.id,
            success: !!evalResponse[0],
            result: evalResponse[1],
            index: evalResponse[2]
        }));
    }

    /**
     * Extends that TTL for a lock that is already owned.
     * Fails if modification index in lock provided is not currently holding the lock.
     *
     * @param lock A lock returned by acquireLock or waitAcquireLock
     * @param ttl The new TTL (ms), counted from now. Must be a positive integer
     */
    extendLock(lock: LockHandle, ttl: number): Promise<ExtendResult>;
    extendLock(lock: LockHandle, ttl: number, callback: LockCallback<ExtendResult>): void;
    extendLock(lock: LockHandle, ttl: number, callback?: LockCallback<ExtendResult>): Promise<ExtendResult> | void {
        if (arguments.length > 2) {
            return callbackify((l: LockHandle, t: number) => this.extendLock(l, t))(lock, ttl, callback as LockCallback<ExtendResult>);
        }

        if (!isValidTtl(ttl)) {
            return invalidTtl(ttl);
        }

        if (!isLockHandle(lock)) {
            return invalidLock(lock);
        }

        return this._command<ScriptReply | [0]>('extendLock', this._lockKey(lock.id), lock.index, ttl).then(evalResponse => ({
            id: lock.id,
            success: !!evalResponse[0],
            index: evalResponse[1],
            ttl: evalResponse[2]
        }));
    }

    /**
     * Acquire a lock for a specific ID value. If the lock is not available then waits
     * up to `waitTtl` milliseconds before giving up.
     *
     * @param id Identifies the lock. This is an arbitrary string that should be consistent among
     *    different processes trying to acquire this lock.
     * @param lockTtl Automatically release acquired lock after TTL (ms). Must be a positive integer
     * @param waitTtl Give up after this many milliseconds, or wait indefinitely if the value is 0 or not set
     */
    waitAcquireLock(id: LockId, lockTtl: number, waitTtl?: number): Promise<AcquireResult>;
    waitAcquireLock(id: LockId, lockTtl: number, waitTtl: number | undefined, callback: LockCallback<AcquireResult>): void;
    waitAcquireLock(id: LockId, lockTtl: number, waitTtl?: number, callback?: LockCallback<AcquireResult>): Promise<AcquireResult> | void {
        if (arguments.length > 3) {
            return callbackify((i: LockId, l: number, w: number | undefined) => this.waitAcquireLock(i, l, w))(
                id,
                lockTtl,
                waitTtl,
                callback as LockCallback<AcquireResult>
            );
        }

        return new Promise((resolve, reject) => {
            const lockKey = this._lockKey(id);
            let expired = false; // flag to indicate that the TTL wait time was expired
            let acquiring = false; // flag to indicate that a Redis query is in process

            let ttlTimer: NodeJS.Timeout | undefined;
            let expireLockTimer: NodeJS.Timeout | undefined;

            // A looping function that tries to acquire a lock. The loop goes on until
            // the lock is acquired or the wait ttl kicks in
            const tryAcquire = () => {
                this._subscribers.removeListener(lockKey, tryAcquire); // clears pubsub listener
                clearTimeout(ttlTimer); // clears the timer that waits until existing lock is expired
                acquiring = true;
                this.acquireLock(id, lockTtl)
                    .then(lock => {
                        acquiring = false;
                        if (lock.success || expired) {
                            // we got a lock or the wait TTL was expired, return what we have
                            clearTimeout(expireLockTimer);
                            return resolve(lock);
                        }

                        // Wait for either a Redis publish event or for the lock expiration timer to expire
                        this._subscribers.addListener(lockKey, tryAcquire);
                        // Remaining TTL for the lock might be very low, even 0 (lock expires by next ms)
                        // in any case we do not make a next polling try sooner than after 100ms delay
                        // We might make the call sooner if the key is released manually and we get a notification
                        // from Redis PubSub about it
                        let delay = Math.min(Math.max(lock.ttl + 10, 100), MAX_TIMER_DELAY);
                        if (this._pubsubRefused) {
                            // No release notifications will arrive, so do not sleep out a long TTL
                            delay = Math.min(delay, POLL_INTERVAL_WITHOUT_PUBSUB);
                        }
                        ttlTimer = setTimeout(tryAcquire, delay);
                    })
                    .catch((err: Error) => {
                        // stop waiting if we hit into an error
                        this._subscribers.removeListener(lockKey, tryAcquire);
                        clearTimeout(expireLockTimer);
                        return reject(err);
                    });
            };

            const expire = () => {
                expired = true;
                this._subscribers.removeListener(lockKey, tryAcquire);
                clearTimeout(ttlTimer);
                // Try one last time and return whatever the acquireLock returns
                if (!acquiring) {
                    return tryAcquire();
                }
            };

            // A wait longer than the largest timer delay is split into several timers
            const armExpiry = (remaining: number) => {
                const delay = Math.min(remaining, MAX_TIMER_DELAY);
                expireLockTimer = setTimeout(() => (remaining > delay ? armExpiry(remaining - delay) : expire()), delay);
            };

            if (waitTtl && waitTtl > 0) {
                armExpiry(waitTtl);
            }

            // try to acquire a lock
            tryAcquire();
        });
    }

    /**
     * Acquires a lock (waiting up to `waitTtl` like `waitAcquireLock`), runs `fn` while holding
     * it and always releases it afterwards, whether `fn` resolved or threw. Resolves to what `fn`
     * returns and rejects with what it throws. A failed release does not change that outcome
     * (the lock expires after its TTL anyway), it is emitted as an `error` event when a listener
     * is attached.
     *
     * Rejects with a `LockError` (`code: 'ELOCKNOTACQUIRED'`) when the lock was not obtained in
     * time, and with the Redis error when acquiring failed for another reason; `fn` is not called
     * in either case.
     *
     * @param id Identifies the lock
     * @param ttl Lock TTL (ms). Must be a positive integer
     * @param waitTtl Give up after this many milliseconds, or wait indefinitely if the value is 0 or undefined
     * @param fn Runs while the lock is held, called with the lock and an AbortSignal
     * @param opts `extend: true` keeps the lock alive while `fn` runs
     */
    async withLock<T>(id: LockId, ttl: number, waitTtl: number | undefined, fn: WithLockFunction<T>, opts?: WithLockOptions): Promise<Awaited<T>> {
        if (typeof fn !== 'function') {
            throw new TypeError(`Expected a function to run while holding the lock, got ${String(fn)}`);
        }

        const lock = await this.waitAcquireLock(id, ttl, waitTtl);
        if (!lock.success) {
            throw new LockError(lock.replicationFailure ? 'Lock was not replicated in time' : 'Lock is held by someone else', 'ELOCKNOTACQUIRED', {
                id,
                index: lock.index,
                ttl: lock.ttl,
                replicationFailure: lock.replicationFailure
            });
        }

        const controller = new AbortController();
        const extender = opts?.extend ? this._autoExtend(lock, ttl, controller) : undefined;
        try {
            return await fn(lock, controller.signal);
        } finally {
            if (extender) {
                await extender.stop();
            }
            try {
                await this.releaseLock(lock);
            } catch (err) {
                if (this.listenerCount('error')) {
                    this.emit('error', err);
                }
            }
        }
    }

    /** @internal Extends the lock every ttl/2 until stopped or an extension fails */
    _autoExtend(lock: AcquireResult, ttl: number, controller: AbortController): { stop(): Promise<void> } {
        const interval = Math.max(1, Math.min(Math.floor(ttl / 2), MAX_TIMER_DELAY));
        let stopped = false;
        let timer: NodeJS.Timeout | undefined;
        let pending: Promise<void> = Promise.resolve();

        const lost = (cause: unknown) => {
            controller.abort(
                new LockError('Failed to extend the lock, it may be held by someone else', 'ELOCKLOST', { id: lock.id, index: lock.index, ttl: 0, cause })
            );
        };

        const schedule = () => {
            timer = setTimeout(() => {
                pending = this.extendLock(lock, ttl).then(
                    result => {
                        if (!result.success) {
                            return lost(result);
                        }
                        if (!stopped) {
                            schedule();
                        }
                    },
                    err => lost(err)
                );
            }, interval);
            // the function the lock protects keeps the process alive, not the extension
            timer.unref();
        };
        schedule();

        return {
            stop: () => {
                stopped = true;
                clearTimeout(timer);
                // let an extension in flight settle so it can not land after the release
                return pending;
            }
        };
    }
}

// Non-enumerable, so the module keeps the shape `require('ioredfour')` always had
Object.defineProperty(Lock, 'LockError', { value: LockError, enumerable: false, writable: true, configurable: true });

export default Lock;
