# Changelog

## [0.7.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.7.0...v0.7.1) (2025-10-09)


### Bug Fixes

* build cars in the browser ([#83](https://github.com/filecoin-project/filecoin-pin/issues/83)) ([4ec9a0f](https://github.com/filecoin-project/filecoin-pin/commit/4ec9a0f97a6f5763fa441c6b126f43f280673247))

## [0.7.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.6.0...v0.7.0) (2025-10-08)


### Features

* provide lib access via import from 'filecoin-pin/core' ([#82](https://github.com/filecoin-project/filecoin-pin/issues/82)) ([066c66b](https://github.com/filecoin-project/filecoin-pin/commit/066c66b7b4660a62fa74ec6c8b25b620c2d7b09e))


### Bug Fixes

* deposit allows passing days or amount ([#72](https://github.com/filecoin-project/filecoin-pin/issues/72)) ([f34c8e5](https://github.com/filecoin-project/filecoin-pin/commit/f34c8e5f362ad6726090a87d88a5c7c7362f8471))
* lint failures on extension names ([#70](https://github.com/filecoin-project/filecoin-pin/issues/70)) ([4429e7a](https://github.com/filecoin-project/filecoin-pin/commit/4429e7acb912a9a86ad870779d161639fe6ee710))
* ux friendly payment funds subcommand ([#75](https://github.com/filecoin-project/filecoin-pin/issues/75)) ([837879b](https://github.com/filecoin-project/filecoin-pin/commit/837879b8f23a49a62dd2c9ac3c5d33b8bd3ae79c))


### Chores

* **deps:** bump @filoz/synapse-sdk from 0.28.0 to 0.29.3 ([#63](https://github.com/filecoin-project/filecoin-pin/issues/63)) ([48246ea](https://github.com/filecoin-project/filecoin-pin/commit/48246ea198261929520c73a7ce4aefe5ad6e3b54))
* **deps:** bump pino from 9.13.1 to 10.0.0 ([#64](https://github.com/filecoin-project/filecoin-pin/issues/64)) ([f7f84d1](https://github.com/filecoin-project/filecoin-pin/commit/f7f84d1b59732ac42807f8456261491eac6ab526))

## [0.6.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.5.0...v0.6.0) (2025-09-29)


### Features

* add data-set command ([#50](https://github.com/filecoin-project/filecoin-pin/issues/50)) ([8b83a02](https://github.com/filecoin-project/filecoin-pin/commit/8b83a022432f0fd2fc12a0117e565265273b2fbd))
* allow overriding provider ([#53](https://github.com/filecoin-project/filecoin-pin/issues/53)) ([70681de](https://github.com/filecoin-project/filecoin-pin/commit/70681de574e0ac4a4619efa499af81086ac2da6f))
* make WarmStorage approvals infinite, focus only on deposit ([#47](https://github.com/filecoin-project/filecoin-pin/issues/47)) ([1064d78](https://github.com/filecoin-project/filecoin-pin/commit/1064d78b86fa55a3d1b850a898703683a1172700))
* status,deposit,withdraw cmds ([#52](https://github.com/filecoin-project/filecoin-pin/issues/52)) ([278ed5a](https://github.com/filecoin-project/filecoin-pin/commit/278ed5a5ae54aa8cc068083e0a884fdebebf5fdf))

## [0.5.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.4.1...v0.5.0) (2025-09-25)


### Features

* **add:** implement `add` command with unixfs packing for single file ([690e06b](https://github.com/filecoin-project/filecoin-pin/commit/690e06b5cc2a9d4334626aa0aff2c2c9dcfae3be))
* **add:** support whole directory adding ([69c9067](https://github.com/filecoin-project/filecoin-pin/commit/69c90672e8f18e1f4f8a61e0e65893144c228eac))
* **add:** wrap file in directory by default, opt-out with --bare ([316237b](https://github.com/filecoin-project/filecoin-pin/commit/316237bc4362f2afb14cdcd16f7283ee10a4e455))


### Bug Fixes

* storage calculations are accurate and precise ([#36](https://github.com/filecoin-project/filecoin-pin/issues/36)) ([cc56cc1](https://github.com/filecoin-project/filecoin-pin/commit/cc56cc1ab1cfbf039f2f323498a6230f5d0dc5f1))


### Chores

* use size constants, add tests, enable coverage ([#35](https://github.com/filecoin-project/filecoin-pin/issues/35)) ([9aab57f](https://github.com/filecoin-project/filecoin-pin/commit/9aab57fae4e17ab702c12079eca3d82a7307b5c4))

## [0.4.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.4.0...v0.4.1) (2025-09-23)


### Bug Fixes

* payments setup script no longer hangs ([#32](https://github.com/filecoin-project/filecoin-pin/issues/32)) ([688389f](https://github.com/filecoin-project/filecoin-pin/commit/688389f5e57d68ed1f46dba37463343a7e1fde31))


### Chores

* **payments:** if no actions taken, print appropriate msg ([#34](https://github.com/filecoin-project/filecoin-pin/issues/34)) ([1b66655](https://github.com/filecoin-project/filecoin-pin/commit/1b6665513bddf354854581db0b67d8dcc1706380))

## [0.4.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.3.0...v0.4.0) (2025-09-19)


### Features

* check payments status on import command ([91b5628](https://github.com/filecoin-project/filecoin-pin/commit/91b56284a25e186cf69d3c4e03fbd474073c95ba))


### Chores

* misc cleanups and refactoring ([afc19ae](https://github.com/filecoin-project/filecoin-pin/commit/afc19ae17f5b03e534ec5d747ba1212fba7e613e))

## [0.3.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.2.2...v0.3.0) (2025-09-19)


### Features

* filecoin-pin import /path/to/car ([#26](https://github.com/filecoin-project/filecoin-pin/issues/26)) ([d607af8](https://github.com/filecoin-project/filecoin-pin/commit/d607af82eeae1c5940b17abfbc2b6ecb7f34ecc0))


### Chores

* rearrange Synapse use to improve educational value ([#28](https://github.com/filecoin-project/filecoin-pin/issues/28)) ([5eac7ef](https://github.com/filecoin-project/filecoin-pin/commit/5eac7ef00b8812b848f5358a9a147bce64b56c3f))
* update release-please config to be more comprehensive ([#29](https://github.com/filecoin-project/filecoin-pin/issues/29)) ([647e673](https://github.com/filecoin-project/filecoin-pin/commit/647e673b9113a9fe7c77ff0932c8db80aec40584))

## [0.2.2](https://github.com/filecoin-project/filecoin-pin/compare/v0.2.1...v0.2.2) (2025-09-18)


### Bug Fixes

* make output consistent, reduce duplication ([bd97854](https://github.com/filecoin-project/filecoin-pin/commit/bd97854f27132ed187a9f78eeb04c14ba662dd32))
* payments storage pricing consistency ([b859bcb](https://github.com/filecoin-project/filecoin-pin/commit/b859bcbc99cce48f5dc1b9f1c2dc8ca8691cda94))

## [0.2.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.2.0...v0.2.1) (2025-09-18)


### Bug Fixes

* tweak payments language, fix minor flow issues ([#22](https://github.com/filecoin-project/filecoin-pin/issues/22)) ([3a1d187](https://github.com/filecoin-project/filecoin-pin/commit/3a1d187f2f8f848cbc52c2316deab4fa3641aead))

## [0.2.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.1.0...v0.2.0) (2025-09-17)


### Features

* add `filecoin-pin payments setup` (and more) ([#16](https://github.com/filecoin-project/filecoin-pin/issues/16)) ([08400c4](https://github.com/filecoin-project/filecoin-pin/commit/08400c4835aa075b4e940dba9f7bd242dbe74479))
* add commander CLI parsing, s/daemon/server, improve docs ([3c66065](https://github.com/filecoin-project/filecoin-pin/commit/3c66065b7ca76e7c944ca2a22a17092b4d650b86))
* update deps; adapt to latest synapse-sdk; integrate biome ([b543926](https://github.com/filecoin-project/filecoin-pin/commit/b543926a47c92a43eabe724993036f81a7008c0f))


### Bug Fixes

* configure release-please tags ([06bf6bc](https://github.com/filecoin-project/filecoin-pin/commit/06bf6bc9589cf6d293ca7deeb9afc0ea7bbc72c4))
* release-please config ([54f0bdc](https://github.com/filecoin-project/filecoin-pin/commit/54f0bdce2b65d4153ca2e1d3a048849c190ee76e))

## Changelog
