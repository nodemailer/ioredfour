// Builds the package.
//
// 1. Compiles src/ twice with tsc: once as ES modules into dist/esm and once as
//    CommonJS into dist/cjs. Each output directory gets its own package.json
//    that pins the module format.
// 2. Rewrites the CommonJS files that only have a default export so that
//    `require()` keeps returning the exported class itself, the same shape the
//    pre-TypeScript CommonJS sources had (`module.exports = Lock`).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = require.resolve('typescript/bin/tsc');

function runTsc(project, ...args) {
    const result = spawnSync(process.execPath, [tsc, '-p', project, ...args], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function listFiles(dir, ext) {
    return fs
        .readdirSync(dir, { recursive: true })
        .filter(name => name.endsWith(ext))
        .map(name => path.join(dir, name));
}

// tsc emits `exports.default = X` for `export default X`. For modules whose only
// runtime export is the default one, make `require()` return X directly. The
// default export stays reachable as a non-enumerable `.default` property, which
// is what TypeScript and Babel generated `import X from '...'` code reads.
//
// A module that has a default export and named runtime exports can not get this
// treatment, so the build fails for one: silently switching `require()` from the
// class to the exports object would break `require('ioredfour')` callers.
function applyCjsInterop(dir) {
    const namedExport = /\bexports\.(?!default\b)[A-Za-z_$][\w$]*\s*=/;
    const definedExport = /Object\.defineProperty\(exports,\s*"(?!__esModule")/;
    const starExport = /__exportStar\(/;
    const defaultExport = /\bexports\.default\s*=/;

    for (const file of listFiles(dir, '.js')) {
        const source = fs.readFileSync(file, 'utf8');
        if (!defaultExport.test(source)) {
            continue;
        }
        const name = path.relative(dir, file);
        if (namedExport.test(source) || definedExport.test(source) || starExport.test(source)) {
            throw new Error(
                name +
                    ' has a default export and named runtime exports. Keep default-export modules default-only ' +
                    '(attach extra values as properties of the exported class)'
            );
        }
        const shim =
            'module.exports = exports.default;\n' +
            "Object.defineProperty(module.exports, 'default', { value: exports.default, enumerable: false, writable: true, configurable: true });\n";
        const mapComment = source.lastIndexOf('//# sourceMappingURL=');
        const patched = mapComment === -1 ? source + shim : source.slice(0, mapComment) + shim + source.slice(mapComment);
        fs.writeFileSync(file, patched);
    }
}

function build() {
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

    runTsc('tsconfig.esm.json');
    // The ES module compile has already type-checked the same sources
    runTsc('tsconfig.cjs.json', '--noCheck');

    fs.writeFileSync(path.join(root, 'dist', 'esm', 'package.json'), JSON.stringify({ type: 'module' }, null, 4) + '\n');
    fs.writeFileSync(path.join(root, 'dist', 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 4) + '\n');

    applyCjsInterop(path.join(root, 'dist', 'cjs'));
}

build();
