# Changelog

## [2.1.0](https://github.com/nodemailer/ioredfour/compare/v2.0.0...v2.1.0) (2026-10-21)


### Features

* add withLock() to run a function under a lock with optional auto-extension ([6f51dff](https://github.com/nodemailer/ioredfour/commit/6f51dffadf29e6c1861ce7cf043fe0ebfb961bc7))

## [2.0.0](https://github.com/nodemailer/ioredfour/compare/v1.4.4...v2.0.0) (2026-10-19)


### ⚠ BREAKING CHANGES

* the package now has an exports map, so only the entry point, ioredfour/lib/ioredfour, ioredfour/lib/scripts and package.json can be required. TTLs above 999999999999999 ms are rejected.

### Features

* migrate to TypeScript with ES module and CommonJS builds ([3087266](https://github.com/nodemailer/ioredfour/commit/3087266d88b594276a2e3434c51a3e77f81745ea))


### Bug Fixes

* reject lock TTLs that PEXPIRE can not apply instead of leaving a lock key without expiry ([3087266](https://github.com/nodemailer/ioredfour/commit/3087266d88b594276a2e3434c51a3e77f81745ea))
* stop waitAcquireLock from busy-polling or giving up early on timer delays above 2^31-1 ms ([3087266](https://github.com/nodemailer/ioredfour/commit/3087266d88b594276a2e3434c51a3e77f81745ea))
* wake waiters after the release channel subscription is established or restored ([3087266](https://github.com/nodemailer/ioredfour/commit/3087266d88b594276a2e3434c51a3e77f81745ea))

## [1.4.4](https://github.com/nodemailer/ioredfour/compare/v1.4.3...v1.4.4) (2026-09-28)


### Bug Fixes

* handle a refused subscription, validate lock TTLs, and pass the channel as a script argument ([174ebbe](https://github.com/nodemailer/ioredfour/commit/174ebbe8975298e441d31a490681306a0ca72709))

## [1.4.3](https://github.com/nodemailer/ioredfour/compare/v1.4.2...v1.4.3) (2026-08-24)


### Bug Fixes

* **deps:** move to ioredis 6 ([59e8038](https://github.com/nodemailer/ioredfour/commit/59e8038c4646b5c8b369938641b172f18563aadf))

## [1.4.2](https://github.com/nodemailer/ioredfour/compare/v1.4.1...v1.4.2) (2026-07-20)


### Bug Fixes

* **deps:** update ioredis to 5.11.1 ([297add3](https://github.com/nodemailer/ioredfour/commit/297add3cc2cfc73da86b682321efa459f7b4cc9d))

## [1.4.1](https://github.com/nodemailer/ioredfour/compare/v1.4.0...v1.4.1) (2026-03-23)


### Bug Fixes

* improve acquireLock replication retry reliability ([5050a87](https://github.com/nodemailer/ioredfour/commit/5050a87977700b17f5b60e3d68ae833f7fe3cdbb))

## [1.4.0](https://github.com/nodemailer/ioredfour/compare/v1.3.0...v1.4.0) (2026-02-25)

### Features

- Merge pull request [#5](https://github.com/nodemailer/ioredfour/issues/5) from NickOvt/ZMS-6 (ZMS-6: add support for redis cluster) ([47a8068](https://github.com/nodemailer/ioredfour/commit/47a8068f76c038e1799de8ec65ee83e7f1a4f422))
- **wait:** If minReplications is not set then do not use WAIT ([7bd2606](https://github.com/nodemailer/ioredfour/commit/7bd2606ec01e6495024721694735354c3a3dbca2))

## [1.3.0-ioredis-07](https://github.com/nodemailer/ioredfour/compare/v1.2.0-ioredis-07...v1.3.0-ioredis-07) (2024-01-03)

### Features

- **wait:** If minReplications is not set then do not use WAIT ([7bd2606](https://github.com/nodemailer/ioredfour/commit/7bd2606ec01e6495024721694735354c3a3dbca2))
