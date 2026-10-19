// Lua scripts that run atomically in Redis. Each one is registered as a custom ioredis command
// by the Lock constructor.

// Largest TTL (ms) the scripts accept, 15 digits or about 31000 years. The JavaScript side enforces
// the same bound. ioredis parses integer replies close to Number.MAX_SAFE_INTEGER inexactly, so
// the bound stays well below it.
export const MAX_TTL = 999999999999999;

// Validates the TTL in `ARGV[n]` as a string of decimal digits, before any write: a Lua error does
// not roll back earlier writes. A tonumber() check let through values PEXPIRE rejects, such as
// 1e20, and the lock key the HSET had already created was left behind with no expiry at all.
// tonumber() also accepts hex, exponents, fractions and surrounding spaces ("0x10", "1e3", "5.0",
// " 5"). The digit string itself is what PEXPIRE gets.
const validateTtl = (argv: number) => `
        local ttl = ARGV[${argv}];
        if not string.match(ttl, "^[1-9]%d*$") or string.len(ttl) > ${String(MAX_TTL).length} then
            return redis.error_reply("ERR ioredfour: lock TTL must be a positive integer");
        end;`;

export const acquireScript = () => `${validateTtl(1)}
        if redis.call("EXISTS", KEYS[1]) == 1 then
            return {0, -1, redis.call("PTTL", KEYS[1])};
        end;
        --[[
            Use a global incrementing counter
            It is a signed 64bit integer, so it should not overflow any time soon.
            The number gets converted to JS which uses 64bit floats but even if the
            boundary would be much smaller Number.MAX_SAFE_INTEGER it would take thousands
            of years to reach that limit assuming we make 100k incrementations in a second
        --]]
        local index = redis.call("INCR", KEYS[2]);
        redis.call("HSET", KEYS[1], "index", index);
        redis.call("PEXPIRE", KEYS[1], ttl);
        return {1, index, tonumber(ttl)};
    `;

export const extendScript = () => `${validateTtl(2)}
        if redis.call("HGET", KEYS[1], "index") == ARGV[1] then
            redis.call("PEXPIRE", KEYS[1], ttl);
            return {1, tonumber(ARGV[1]), tonumber(ttl)};
        end;
        return {0};
    `;

// ARGV[2] is the release channel and ARGV[3] the unprefixed lock key waiters listen for. Both
// are passed as arguments rather than pasted into the source, so a namespace containing quotes
// or backslashes cannot break the script, and an ioredis keyPrefix (which rewrites KEYS[1]) does
// not change the published message.
export const releaseScript = (useShardedPubSub?: boolean) => {
    const publishCommand = useShardedPubSub ? 'SPUBLISH' : 'PUBLISH';

    return `
        local index = redis.call("HGET", KEYS[1], "index");
        if not index then
            return {1, "expired", 0};
        end;
        index = tonumber(index);
        if index == tonumber(ARGV[1]) then
            redis.call("DEL", KEYS[1]);
            -- Notify potential queue that this lock is now freed
            redis.call("${publishCommand}", ARGV[2], ARGV[3]);
            return {1, "released", index};
        end;
        return {0, "conflict", index};
    `;
};
