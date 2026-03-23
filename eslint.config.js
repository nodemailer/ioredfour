'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const nodemailerConfig = require('eslint-config-nodemailer');
const prettierConfig = require('eslint-config-prettier/flat');

module.exports = [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2018,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.mocha,
                BigInt: true
            }
        },
        rules: {
            ...nodemailerConfig.rules,
            indent: 'off',
            'no-await-in-loop': 'off',
            'require-atomic-updates': 'off',
            'no-dupe-else-if': 'off',
            'no-import-assign': 'off',
            'no-setter-return': 'off'
        }
    },
    prettierConfig
];
