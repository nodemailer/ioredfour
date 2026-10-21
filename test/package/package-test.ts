import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests exercise the compiled output in dist/ (built by the pretest script) through the
// package.json exports map, the same way an installed copy of the package is loaded. Node resolves
// the package name to the package itself when the specifier is used from inside the package.
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Non-literal specifiers keep TypeScript from resolving the built types at type-check time, when
// dist/ may not exist yet
const packageName: string = 'ioredfour';

const hasDist = fs.existsSync(path.join(root, 'dist', 'cjs', 'ioredfour.js')) && fs.existsSync(path.join(root, 'dist', 'esm', 'ioredfour.js'));

// Every lock method of the pre-TypeScript CommonJS class
const LOCK_METHODS = ['acquireLock', 'releaseLock', 'extendLock', 'waitAcquireLock', 'withLock', 'close'];

describe('Built package', { timeout: 30 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            for (const file of ['ioredfour.js', 'ioredfour.d.ts', 'scripts.js', 'scripts.d.ts']) {
                assert.ok(fs.existsSync(path.join(root, 'dist', format, file)), `${format}/${file}`);
            }
        }
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'esm', 'package.json'), 'utf8')), { type: 'module' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('points main, types and every exports entry at an existing file', () => {
        assert.strictEqual(pkg.main, './dist/cjs/ioredfour.js');
        assert.strictEqual(pkg.exports['.'].require, './dist/cjs/ioredfour.js');
        assert.strictEqual(pkg.exports['.'].import, './dist/esm/ioredfour.js');
        assert.ok(fs.existsSync(path.join(root, pkg.types)));
        for (const [subpath, entry] of Object.entries(pkg.exports)) {
            if (subpath.includes('*')) {
                continue;
            }
            const targets = typeof entry === 'string' ? [entry] : Object.values(entry as Record<string, string>);
            for (const target of targets) {
                assert.ok(fs.existsSync(path.join(root, target)), `${subpath} points at a missing file ${target}`);
            }
        }
    });

    it('does not ship the TypeScript sources or the test suite', () => {
        assert.ok(pkg.files.includes('dist'));
        assert.ok(!pkg.files.includes('src'));
        assert.ok(!pkg.files.includes('test'));
        assert.ok(!pkg.files.includes('lib/'));
    });

    it('keeps ES module syntax out of the CommonJS build', () => {
        // The CommonJS build must not reach ES module code, see the platform constraints in CLAUDE.md
        const cjs = fs.readFileSync(path.join(root, 'dist', 'cjs', 'ioredfour.js'), 'utf8');
        assert.doesNotMatch(cjs, /\bimport\s*\(/);
        assert.doesNotMatch(cjs, /import\.meta/);
        assert.match(cjs, /require\("ioredis"\)/);
    });

    describe('CommonJS build', () => {
        it('resolves require() to the CommonJS entry point', () => {
            assert.strictEqual(require.resolve(packageName), path.join(root, 'dist', 'cjs', 'ioredfour.js'));
        });

        it('returns the Lock class itself, as module.exports = Lock did', () => {
            const Lock = require(packageName);
            assert.strictEqual(typeof Lock, 'function');
            assert.strictEqual(Lock.name, 'Lock');
            for (const method of LOCK_METHODS) {
                assert.strictEqual(typeof Lock.prototype[method], 'function', method);
            }
            // transpiled `import Lock from 'ioredfour'` reads .default; it must not show up as a key
            assert.strictEqual(Lock.default, Lock);
            assert.deepStrictEqual(Object.keys(Lock), []);
            assert.ok(Lock.prototype instanceof EventEmitter);
            // the withLock error class hangs off the class, not off the module
            assert.strictEqual(typeof Lock.LockError, 'function');
            assert.ok(Lock.LockError.prototype instanceof Error);
        });

        it('keeps the lib/ deep imports of the JavaScript package working', () => {
            const Lock = require(packageName);
            for (const name of ['ioredfour/lib/ioredfour', 'ioredfour/lib/ioredfour.js']) {
                assert.strictEqual(require(name), Lock, name);
            }
            for (const name of ['ioredfour/lib/scripts', 'ioredfour/lib/scripts.js']) {
                const scripts = require(name);
                assert.strictEqual(typeof scripts.acquireScript(), 'string', name);
                assert.strictEqual(typeof scripts.extendScript(), 'string', name);
                assert.match(scripts.releaseScript(true), /SPUBLISH/, name);
                assert.match(scripts.releaseScript(false), /"PUBLISH"/, name);
            }
            assert.strictEqual(require('ioredfour/package.json').name, 'ioredfour');
        });

        it('reaches every CommonJS module from the entry point', () => {
            // pkg follows the exports map only for ES modules, a CommonJS deep import such as
            // ioredfour/lib/scripts is resolved inside the binary from the files the entry point
            // pulled in. A module that only a deep import reaches would be missing from it
            const script = `require(${JSON.stringify(path.join(root, pkg.main))}); console.log(JSON.stringify(Object.keys(require.cache)))`;
            const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
            assert.strictEqual(result.status, 0, result.stderr);
            const loaded = new Set(JSON.parse(result.stdout));
            const cjsRoot = path.join(root, 'dist', 'cjs');
            for (const file of fs.readdirSync(cjsRoot).filter(name => name.endsWith('.js'))) {
                assert.ok(loaded.has(path.join(cjsRoot, file)), `${file} is not loaded by the entry point`);
            }
        });
    });

    describe('ES module build', () => {
        it('resolves import to the ES module entry point', async () => {
            const direct = await import(new URL('../../dist/esm/ioredfour.js', import.meta.url).href);
            const byName = await import(packageName);
            assert.strictEqual(byName.default, direct.default);
            assert.notStrictEqual(byName.default, require(packageName));
        });

        it('has the Lock class as its only runtime export', async () => {
            const mod = await import(packageName);
            assert.deepStrictEqual(Object.keys(mod), ['default']);
            assert.strictEqual(mod.default.name, 'Lock');
            for (const method of LOCK_METHODS) {
                assert.strictEqual(typeof mod.default.prototype[method], 'function', method);
            }
            assert.ok(mod.default.LockError.prototype instanceof Error);
        });

        it('exposes the deep imports', async () => {
            const { default: Lock } = await import(packageName);
            assert.strictEqual((await import(packageName + '/lib/ioredfour.js')).default, Lock);
            const scripts = await import(packageName + '/lib/scripts');
            assert.strictEqual(typeof scripts.acquireScript, 'function');
        });
    });
});
