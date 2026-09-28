'use strict';

// Validate the TTL before any write: a Lua error does not roll back earlier writes, so a
// missing or fractional TTL used to leave a lock key behind with no expiry at all.
let acquireScript = () => `
        local ttl=tonumber(ARGV[1]);
        if not ttl or ttl <= 0 or ttl ~= math.floor(ttl) then
            return redis.error_reply("ERR ioredfour: lock TTL must be a positive integer");
        end;
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
        return {1, index, ttl};
    `;

let extendScript = () => `
        local ttl = tonumber(ARGV[2]);
        local index = tonumber(ARGV[1]);
        if not ttl or ttl <= 0 or ttl ~= math.floor(ttl) then
            return redis.error_reply("ERR ioredfour: lock TTL must be a positive integer");
        end;
        if redis.call("HGET", KEYS[1], "index") == ARGV[1] then
            redis.call("PEXPIRE", KEYS[1], ttl);
            return {1, index, ttl};
        else
            return {0};
        end;
    `;

// ARGV[2] is the release channel and ARGV[3] the unprefixed lock key waiters listen for. Both
// are passed as arguments rather than pasted into the source, so a namespace containing quotes
// or backslashes cannot break the script, and an ioredis keyPrefix (which rewrites KEYS[1]) does
// not change the published message.
let releaseScript = useShardedPubSub => {
    let publishCommand = useShardedPubSub ? 'SPUBLISH' : 'PUBLISH';

    return `
        local index = tonumber(ARGV[1]);
        if redis.call("EXISTS", KEYS[1]) == 0 then
            return {1, "expired", 0};
        end;
        local data = {
            ["index"]=tonumber(redis.call("HGET", KEYS[1], "index"))
        };
        if data.index == index then
            redis.call("DEL", KEYS[1]);
            -- Notify potential queue that this lock is now freed
            redis.call("${publishCommand}", ARGV[2], ARGV[3]);
            return {1, "released", data.index};
        end;
        return {0, "conflict", data.index};
    `;
};

module.exports = {
    acquireScript,
    extendScript,
    releaseScript
};
