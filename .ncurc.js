'use strict';

module.exports = {
    upgrade: true,
    reject: [
        // 12 is esm only ("type": "module"), and grunt-mocha-test require()s it as a
        // constructor - "Mocha is not a constructor". Lift it when the runner drops grunt.
        'mocha',
        // ESM
        'chai'
    ]
};
