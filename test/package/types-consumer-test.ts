import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The suite runs through tsx, which strips the types instead of checking them, and `npm run
// typecheck` checks the types in src/. These tests type-check consumers against the built
// declarations in dist/ the way an installed copy is resolved: the package is linked into a
// temporary project so that the specifiers go through the package.json exports map.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = require.resolve('typescript/bin/tsc');

const hasDist = fs.existsSync(path.join(root, 'dist', 'cjs', 'ioredfour.d.ts')) && fs.existsSync(path.join(root, 'dist', 'esm', 'ioredfour.d.ts'));

// The documented API: every constructor option form, both call styles, the result shapes. The
// callback parameters are left unannotated on purpose, under noImplicitAny they only compile when
// the overloads type them
const consumer = `
import Lock from 'ioredfour';
import type { AcquireResult, ExtendResult, LockHandle, LockOptions, ReleaseResult } from 'ioredfour';
import { Redis, Cluster } from 'ioredis';
import { acquireScript, releaseScript } from 'ioredfour/lib/scripts';

const redis = new Redis();
const options: LockOptions = { redis, namespace: 'consumer', minReplications: 1, replicationTimeout: 500 };
const lock = new Lock(options);
new Lock({ redisConnection: redis });
new Lock({ redis: 'redis://localhost:6379' });
new Lock({ redis: { host: 'localhost', port: 6379 } });
new Lock({ cluster: [{ host: '127.0.0.1', port: 7000 }], clusterOptions: { redisOptions: { password: 'secret' } } });
new Lock({ cluster: true, redis: [{ host: '127.0.0.1', port: 7000 }] });
new Lock({ cluster: { nodes: [{ host: '127.0.0.1', port: 7000 }], options: {} } });
new Lock({ redis: new Cluster([{ host: '127.0.0.1', port: 7000 }]) });

lock.on('error', err => err.message);

export async function run(): Promise<void> {
    const acquired: AcquireResult = await lock.acquireLock('id', 1000);
    const flag: boolean | undefined = acquired.replicationFailure;
    const waited: AcquireResult = await lock.waitAcquireLock(1, 1000, 500);
    await lock.waitAcquireLock('id', 1000);
    const handle: LockHandle = { id: waited.id, index: waited.index };
    const extended: ExtendResult = await lock.extendLock(handle, 2000);
    const ttl: number | undefined = extended.ttl;
    const released: ReleaseResult = await lock.releaseLock(acquired);
    const result: 'released' | 'expired' | 'conflict' = released.result;
    await lock.close();
    void [flag, ttl, result, acquireScript(), releaseScript(true)];

    lock.acquireLock('id', 1000, (err, res) => res.success && err === null);
    lock.waitAcquireLock('id', 1000, 500, (err, res) => res.index + Number(!!err));
    lock.extendLock(acquired, 1000, (err, res) => res.ttl ?? err);
    lock.releaseLock(acquired, (err, res) => res.result.length + Number(!!err));
}
`;

// exactOptionalPropertyTypes consumers can pass an explicit undefined for every option
const exactOptionalConsumer = `
import Lock from 'ioredfour';
declare const maybe: string | undefined;
new Lock({ redis: maybe, redisConnection: undefined, cluster: undefined, clusterOptions: undefined, namespace: maybe, minReplications: undefined, replicationTimeout: undefined });
new Lock({ cluster: { nodes: undefined, startupNodes: [], options: undefined } });
`;

// Compiles to require('ioredfour').default, the non-enumerable alias the build adds
const cjsConsumer = `
import Lock from 'ioredfour';
const lock = new Lock({ redis: 'redis://localhost:6379' });
export const pending: Promise<boolean> = lock.acquireLock('id', 1000).then(res => res.success);
`;

// The internals exist at runtime but are stripped from the declarations
const internalConsumer = `
import Lock from 'ioredfour';
const lock = new Lock({ redis: 'redis://localhost:6379' });
lock._redisConnection;
lock._lockKey('id');
lock.fn('acquireLock');
lock.acquireLock('id', 1000, 'callback');
`;

const node16 = { module: 'node16', moduleResolution: 'node16' };
const resolutions: Array<{ name: string; compilerOptions: { [key: string]: unknown }; type?: string }> = [
    { name: 'node16 ES module project', compilerOptions: node16, type: 'module' },
    { name: 'node16 CommonJS project', compilerOptions: node16 },
    { name: 'bundler resolution', compilerOptions: { module: 'esnext', moduleResolution: 'bundler' }, type: 'module' }
];

// Type-checks consumer sources against the built declarations. With expectedErrors the consumer
// must fail to compile, and every listed message must be among the errors
function typeCheckConsumer(sources: string | string[], compilerOptions: { [key: string]: unknown }, type?: string, expectedErrors?: string[]): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ioredfour-types-'));
    try {
        fs.mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
        // link the package and what a real consumer has installed next to it
        fs.symlinkSync(root, path.join(dir, 'node_modules', 'ioredfour'), 'dir');
        fs.symlinkSync(path.join(root, 'node_modules', 'ioredis'), path.join(dir, 'node_modules', 'ioredis'), 'dir');
        fs.symlinkSync(path.join(root, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'), 'dir');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, ...(type ? { type } : {}) }));
        const files = (Array.isArray(sources) ? sources : [sources]).map((source, index) => {
            const name = `consumer${index}.ts`;
            fs.writeFileSync(path.join(dir, name), source);
            return name;
        });
        fs.writeFileSync(
            path.join(dir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    lib: ['ES2023'],
                    types: ['node'],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noEmit: true,
                    skipLibCheck: true,
                    esModuleInterop: true,
                    ...compilerOptions
                },
                include: files
            })
        );

        const result = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
        const output = result.stdout + result.stderr;
        if (expectedErrors) {
            assert.notStrictEqual(result.status, 0, 'tsc accepted a consumer that must not compile');
            for (const expected of expectedErrors) {
                assert.ok(output.includes(expected), `tsc did not report "${expected}"\n${output}`);
            }
            return;
        }
        assert.strictEqual(result.status, 0, `tsc reported\n${output}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('Built package types', { timeout: 120 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    for (const resolution of resolutions) {
        it(`type-checks a consumer with ${resolution.name}`, () => {
            typeCheckConsumer([consumer, exactOptionalConsumer], resolution.compilerOptions, resolution.type);
        });
    }

    it('type-checks a CommonJS consumer without esModuleInterop', () => {
        typeCheckConsumer(cjsConsumer, { ...node16, esModuleInterop: false, ignoreDeprecations: '6.0' });
    });

    it('strips the internal members from the declarations', () => {
        typeCheckConsumer(internalConsumer, node16, 'module', [
            "Property '_redisConnection' does not exist on type 'Lock'",
            "Property '_lockKey' does not exist on type 'Lock'",
            "Property 'fn' does not exist on type 'Lock'",
            "not assignable to parameter of type 'LockCallback<AcquireResult>'"
        ]);
    });
});
