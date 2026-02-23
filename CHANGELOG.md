# Changelog

## [0.17.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.16.0...v0.17.0) (2026-02-23)


### Features

* **rm:** add --all option to remove all pieces from DataSet ([#320](https://github.com/filecoin-project/filecoin-pin/issues/320)) ([b27050c](https://github.com/filecoin-project/filecoin-pin/commit/b27050cde026826043c0fd38c6635732aafa7293))


### Bug Fixes

* executeUpload and uploadToSynapse to use abortSignals ([#332](https://github.com/filecoin-project/filecoin-pin/issues/332)) ([060257e](https://github.com/filecoin-project/filecoin-pin/commit/060257e0331a416c0e2a1402973c61f16dba03b2))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.3.14 to 2.3.15 ([#331](https://github.com/filecoin-project/filecoin-pin/issues/331)) ([6cb403e](https://github.com/filecoin-project/filecoin-pin/commit/6cb403e5d02045e7fa196cee4f9e2c70d71b3409))
* **deps-dev:** bump @biomejs/biome from 2.3.15 to 2.4.2 ([#336](https://github.com/filecoin-project/filecoin-pin/issues/336)) ([2119892](https://github.com/filecoin-project/filecoin-pin/commit/21198920721fd016b25e2bd93542234458f98869))
* **deps-dev:** bump @biomejs/biome from 2.4.2 to 2.4.3 ([#337](https://github.com/filecoin-project/filecoin-pin/issues/337)) ([a4b3730](https://github.com/filecoin-project/filecoin-pin/commit/a4b3730fd7faf9a29dcc81021ba7a4dace4052c2))
* **deps-dev:** bump @biomejs/biome from 2.4.3 to 2.4.4 ([#338](https://github.com/filecoin-project/filecoin-pin/issues/338)) ([5926600](https://github.com/filecoin-project/filecoin-pin/commit/59266007cf2b79914eea81e7897b6108ef30f646))

## [0.16.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.15.1...v0.16.0) (2026-02-07)


### Features

* add --data-set and --new-data-set flags to add command ([#296](https://github.com/filecoin-project/filecoin-pin/issues/296)) ([e03719b](https://github.com/filecoin-project/filecoin-pin/commit/e03719b32f74456cf2f71f30d7c5c8e32dfc2ed7))
* add provider command with info and ping subcommands ([#295](https://github.com/filecoin-project/filecoin-pin/issues/295)) ([c52ebbf](https://github.com/filecoin-project/filecoin-pin/commit/c52ebbff83612c16c4d637e768ccc62ae01bd6b9))


### Bug Fixes

* use namespace import for Sentry SDK v8+ ESM compatibility ([#319](https://github.com/filecoin-project/filecoin-pin/issues/319)) ([320a461](https://github.com/filecoin-project/filecoin-pin/commit/320a461f1328d254160af11bae2ef783cc326e2a))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.3.13 to 2.3.14 ([#318](https://github.com/filecoin-project/filecoin-pin/issues/318)) ([97f6f1b](https://github.com/filecoin-project/filecoin-pin/commit/97f6f1b3384bbfb616dc053d8683327f910dddc3))
* **deps:** bump @clack/prompts from 0.11.0 to 1.0.0 ([#315](https://github.com/filecoin-project/filecoin-pin/issues/315)) ([63b34e0](https://github.com/filecoin-project/filecoin-pin/commit/63b34e0030527d6c8534804e895fe79cc729cc1e))

## [0.15.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.15.0...v0.15.1) (2026-01-29)


### Bug Fixes

* mainnet flag consideration in payments setup ([#311](https://github.com/filecoin-project/filecoin-pin/issues/311)) ([e74f504](https://github.com/filecoin-project/filecoin-pin/commit/e74f504e1a9520aec1ccb9691caefbc706dada57))
* pass callbacks to synapse-sdk properly ([#316](https://github.com/filecoin-project/filecoin-pin/issues/316)) ([be6f3e8](https://github.com/filecoin-project/filecoin-pin/commit/be6f3e8a151b6395e3f4412a648960f1071b9b9a))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.3.11 to 2.3.13 ([#312](https://github.com/filecoin-project/filecoin-pin/issues/312)) ([8c1db16](https://github.com/filecoin-project/filecoin-pin/commit/8c1db166e9227ea6dc010940f6a97f4d1cf76537))

## [0.15.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.14.0...v0.15.0) (2026-01-16)


### Features

* add filecoin pay funding planner ([#286](https://github.com/filecoin-project/filecoin-pin/issues/286)) ([f22a6c6](https://github.com/filecoin-project/filecoin-pin/commit/f22a6c64f1737d3e95feff2332f00a95364d02b1))
* allow read-only operations with wallet addr ([#284](https://github.com/filecoin-project/filecoin-pin/issues/284)) ([167c148](https://github.com/filecoin-project/filecoin-pin/commit/167c1488a84289bcfd673ebbd60cc04f6ed56f82))


### Bug Fixes

* allow validation of descendent CIDs ([#304](https://github.com/filecoin-project/filecoin-pin/issues/304)) ([57ada31](https://github.com/filecoin-project/filecoin-pin/commit/57ada3126b3a58a4f7ed7afaa275590f75b585aa))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.3.10 to 2.3.11 ([#297](https://github.com/filecoin-project/filecoin-pin/issues/297)) ([049d750](https://github.com/filecoin-project/filecoin-pin/commit/049d750cdc0c4d28f3280c94a22005b3200c274c))
* **deps-dev:** bump @biomejs/biome from 2.3.8 to 2.3.10 ([#294](https://github.com/filecoin-project/filecoin-pin/issues/294)) ([61eda02](https://github.com/filecoin-project/filecoin-pin/commit/61eda02045333a830046c0d9c3d6e016a21203c1))
* **deps-dev:** bump @types/node from 24.10.3 to 25.0.0 ([#289](https://github.com/filecoin-project/filecoin-pin/issues/289)) ([a320f51](https://github.com/filecoin-project/filecoin-pin/commit/a320f51b6b450de7ac849ca4520b3dd4c152c592))
* **deps:** bump @helia/unixfs from 6.0.4 to 7.0.0 ([#301](https://github.com/filecoin-project/filecoin-pin/issues/301)) ([d74b6b5](https://github.com/filecoin-project/filecoin-pin/commit/d74b6b5eacc63b3abfbdb04370e2e7cac268ae4b))


### Documentation

* fix missing `upload-action` npm install step ([#302](https://github.com/filecoin-project/filecoin-pin/issues/302)) ([81e5884](https://github.com/filecoin-project/filecoin-pin/commit/81e5884f174c5eedfc9ab493816468d00555286b))

## [0.14.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.13.0...v0.14.0) (2025-12-08)


### Features

* align main exports across node and browser ([#259](https://github.com/filecoin-project/filecoin-pin/issues/259)) ([70dd804](https://github.com/filecoin-project/filecoin-pin/commit/70dd804500829dbceb7a4fb0ae150d872c7930b6))


### Bug Fixes

* add shared guard to prevent zero pricing ([#237](https://github.com/filecoin-project/filecoin-pin/issues/237)) ([7e87f4c](https://github.com/filecoin-project/filecoin-pin/commit/7e87f4c89617690558be8b3ab903755bdbc73a5a))
* createStorageContext does not require logger ([#267](https://github.com/filecoin-project/filecoin-pin/issues/267)) ([8b88561](https://github.com/filecoin-project/filecoin-pin/commit/8b885618764026be7d1b2358d31cb496fd7a1c24))
* intializeSynapse extends synapse.create options ([#242](https://github.com/filecoin-project/filecoin-pin/issues/242)) ([5d1ca39](https://github.com/filecoin-project/filecoin-pin/commit/5d1ca3956b63edaa1c2a393824236d8906cab6e1))
* pad rawSize for payment calculations ([#251](https://github.com/filecoin-project/filecoin-pin/issues/251)) ([4b2b28f](https://github.com/filecoin-project/filecoin-pin/commit/4b2b28f3b9ce4ba3c76e6b545d0b680f55c87b78))
* payment status storage is accurate ([#276](https://github.com/filecoin-project/filecoin-pin/issues/276)) ([d1ac3d3](https://github.com/filecoin-project/filecoin-pin/commit/d1ac3d38b05461e39614c1f89079ef11e11089d8))
* pieces can be removed from a data-set ([#253](https://github.com/filecoin-project/filecoin-pin/issues/253)) ([c557d95](https://github.com/filecoin-project/filecoin-pin/commit/c557d9537efcd1148d62262fde52cab180de2c00))
* remove npm cache from docs workflow (no lockfile) ([#266](https://github.com/filecoin-project/filecoin-pin/issues/266)) ([5c1b0cb](https://github.com/filecoin-project/filecoin-pin/commit/5c1b0cb12179cd506d89ada857ee30d8d25f022c))
* update upload-action deps ([#265](https://github.com/filecoin-project/filecoin-pin/issues/265)) ([5dd4954](https://github.com/filecoin-project/filecoin-pin/commit/5dd495456723814fd2a2b5396a6cdbb2216a16dd))
* use StorageManager for upload ([#262](https://github.com/filecoin-project/filecoin-pin/issues/262)) ([1ed5283](https://github.com/filecoin-project/filecoin-pin/commit/1ed5283976d73c205e20bf88d96452e9b58e3784))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.3.4 to 2.3.7 ([#261](https://github.com/filecoin-project/filecoin-pin/issues/261)) ([565e126](https://github.com/filecoin-project/filecoin-pin/commit/565e126c6a68b36457587737693263e9ab8ae7f9))
* **deps-dev:** bump @biomejs/biome from 2.3.7 to 2.3.8 ([#274](https://github.com/filecoin-project/filecoin-pin/issues/274)) ([981a7ab](https://github.com/filecoin-project/filecoin-pin/commit/981a7abf5d3689629393c080d95b181e38c6f56a))
* **deps:** bump @octokit/request-error and @actions/artifact ([#225](https://github.com/filecoin-project/filecoin-pin/issues/225)) ([beec41b](https://github.com/filecoin-project/filecoin-pin/commit/beec41bb99ce7bddce9a10b2bb45d1c9bb7b40cb))
* **deps:** bump actions/checkout from 5 to 6 ([#255](https://github.com/filecoin-project/filecoin-pin/issues/255)) ([bc15ef8](https://github.com/filecoin-project/filecoin-pin/commit/bc15ef8f1be2a0a768559e870737136da42746e9))
* **deps:** bump actions/checkout from 5 to 6 ([#272](https://github.com/filecoin-project/filecoin-pin/issues/272)) ([0e1ce5b](https://github.com/filecoin-project/filecoin-pin/commit/0e1ce5bf2ca3d0be273178000c6306b82ef5c56d))
* **deps:** bump actions/github-script from 7 to 8 ([#177](https://github.com/filecoin-project/filecoin-pin/issues/177)) ([d724718](https://github.com/filecoin-project/filecoin-pin/commit/d72471870ce8234760e4368758b124b7f77c6946))
* **deps:** bump actions/upload-pages-artifact from 3 to 4 ([#271](https://github.com/filecoin-project/filecoin-pin/issues/271)) ([b8e98dc](https://github.com/filecoin-project/filecoin-pin/commit/b8e98dcb7ac568597738c4c93891ab6beea3a1ba))


### Documentation

* fix wrong service providers URL ([#270](https://github.com/filecoin-project/filecoin-pin/issues/270)) ([2a16a47](https://github.com/filecoin-project/filecoin-pin/commit/2a16a47ab3fbea72cc9a49f06dcda956ad3daef6))
* generate api docs and publish to gh pages ([#260](https://github.com/filecoin-project/filecoin-pin/issues/260)) ([46d0cf7](https://github.com/filecoin-project/filecoin-pin/commit/46d0cf777e42d8f3cfd47b4d69db0a26c376ab7a))

## [0.13.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.12.0...v0.13.0) (2025-11-14)


### Features

* add --network flag for mainnet and calibration network selection ([#240](https://github.com/filecoin-project/filecoin-pin/issues/240)) ([ced63da](https://github.com/filecoin-project/filecoin-pin/commit/ced63da1cb4d0b9b3f9cd777a1e11d7acae4ee4c))
* allow passing metadata via cli commands ([#226](https://github.com/filecoin-project/filecoin-pin/issues/226)) ([f5a1e6e](https://github.com/filecoin-project/filecoin-pin/commit/f5a1e6e2c086b7891f646cc83f0528fc3324fa85))


### Bug Fixes

* correct Filfox explorer URL format for mainnet and use dynamic network in PDP URLs ([#239](https://github.com/filecoin-project/filecoin-pin/issues/239)) ([ff610e6](https://github.com/filecoin-project/filecoin-pin/commit/ff610e6fb6a9057fe1839ff8dc47bdb65861e17a))
* ipni indexer fetch errors are caught ([#241](https://github.com/filecoin-project/filecoin-pin/issues/241)) ([996af92](https://github.com/filecoin-project/filecoin-pin/commit/996af929f9697b967644997f21a59dcd97733d6d))
* network option works ([#243](https://github.com/filecoin-project/filecoin-pin/issues/243)) ([40c400b](https://github.com/filecoin-project/filecoin-pin/commit/40c400b2dbd0e946f363fc15e3ca51433a387992))


### Documentation

* add glossary, `add` explainer, and content routing FAQ ([#233](https://github.com/filecoin-project/filecoin-pin/issues/233)) ([65f13b0](https://github.com/filecoin-project/filecoin-pin/commit/65f13b0db6c3b683e7842a4508ac0d0eada2702b))

## [0.12.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.11.1...v0.12.0) (2025-11-13)


### Features

* add core/data-set methods ([#210](https://github.com/filecoin-project/filecoin-pin/issues/210)) ([6d81508](https://github.com/filecoin-project/filecoin-pin/commit/6d815080a985e8e6e6134430b4ded4ac803b6997))
* data-set CLI uses filecoin-pin/core/data-set ([#211](https://github.com/filecoin-project/filecoin-pin/issues/211)) ([443e285](https://github.com/filecoin-project/filecoin-pin/commit/443e285534c3312282d6184a0e3c223a288e736b))
* deposit with permit integration ([#202](https://github.com/filecoin-project/filecoin-pin/issues/202)) ([121e342](https://github.com/filecoin-project/filecoin-pin/commit/121e3426fcc097cc971cdc5b1b6980641132366f))
* perform update checks ([#219](https://github.com/filecoin-project/filecoin-pin/issues/219)) ([d27e6e6](https://github.com/filecoin-project/filecoin-pin/commit/d27e6e62736366640db84d6fc79af1189b7f1555))


### Bug Fixes

* add/import validate capacity with floor pricing ([#218](https://github.com/filecoin-project/filecoin-pin/issues/218)) ([70e780f](https://github.com/filecoin-project/filecoin-pin/commit/70e780f131ed7724460fcddfcc72a3546c045c84))
* filecoin-pin/upload-action always builds filecoin-pin ([#204](https://github.com/filecoin-project/filecoin-pin/issues/204)) ([ecfb9e0](https://github.com/filecoin-project/filecoin-pin/commit/ecfb9e08508ce768961040f634b05afd4f72e15a))
* IPNI validation confirms provider in indexer response ([#231](https://github.com/filecoin-project/filecoin-pin/issues/231)) ([71f157d](https://github.com/filecoin-project/filecoin-pin/commit/71f157d90ebbfd778e315bae5cd2c58a0abe363f))
* piece metadata is displayed as is ([#222](https://github.com/filecoin-project/filecoin-pin/issues/222)) ([00e7ff9](https://github.com/filecoin-project/filecoin-pin/commit/00e7ff9352382c73334e02de90c431ac095b63d5))
* refresh payments status CLI output ([#223](https://github.com/filecoin-project/filecoin-pin/issues/223)) ([13f557e](https://github.com/filecoin-project/filecoin-pin/commit/13f557e498951e6d96cf1f0df8a80d7832637ad6))
* remove known-good-providers recommendation in examples ([#214](https://github.com/filecoin-project/filecoin-pin/issues/214)) ([f46eab4](https://github.com/filecoin-project/filecoin-pin/commit/f46eab4e07cfa4c67d9c424587bdb00277daee47))
* upload-action pr comment uses consistent spacing ([#206](https://github.com/filecoin-project/filecoin-pin/issues/206)) ([39a03c0](https://github.com/filecoin-project/filecoin-pin/commit/39a03c0b868b6f29e924ca809deec66928093bbd))


### Chores

* add dataset alias for 'data-set' subcommand ([#224](https://github.com/filecoin-project/filecoin-pin/issues/224)) ([391cd79](https://github.com/filecoin-project/filecoin-pin/commit/391cd79c3abd2059fbd5ce08f6b4c48e08529309))
* **deps-dev:** bump @biomejs/biome from 2.3.3 to 2.3.4 ([#212](https://github.com/filecoin-project/filecoin-pin/issues/212)) ([4edab90](https://github.com/filecoin-project/filecoin-pin/commit/4edab901d2d31edfd86ffa4589479d93094ca3a2))

## [0.11.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.11.0...v0.11.1) (2025-11-04)


### Chores

* **deps-dev:** bump @biomejs/biome from 2.2.7 to 2.3.3 ([#198](https://github.com/filecoin-project/filecoin-pin/issues/198)) ([2e6a20e](https://github.com/filecoin-project/filecoin-pin/commit/2e6a20e930f7472d0259795afc46fa3ab55aa226))
* update to synapse-sdk-v0.35.3 ([#203](https://github.com/filecoin-project/filecoin-pin/issues/203)) ([6a24f00](https://github.com/filecoin-project/filecoin-pin/commit/6a24f0037e3bf7b9ac76c2258ecd4600de8bbbac))

## [0.11.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.10.1...v0.11.0) (2025-11-03)

### ⚠️ Breaking Functionality
With the update to synpase 0.35.x, filecoin-pin is now using a new set of [Filecoin Onchain Cloud contracts](https://github.com/FilOzone/filecoin-services/releases/tag/v1.0.0).  DataSets created previously are no longer accessible through this release of `filecoin-pin`.

### Features

* add more details to upload-flow ([#169](https://github.com/filecoin-project/filecoin-pin/issues/169)) ([9ab3f8c](https://github.com/filecoin-project/filecoin-pin/commit/9ab3f8c110ce0b6c6bf21c1fcdbcf84ade557953))
* use synapse-sdk telemetry ([#154](https://github.com/filecoin-project/filecoin-pin/issues/154)) ([15c00ee](https://github.com/filecoin-project/filecoin-pin/commit/15c00eee5f13319e01a30a748fea991dbcbea897))


### Bug Fixes

* add signer support to initializeSynapse ([#172](https://github.com/filecoin-project/filecoin-pin/issues/172)) ([1d5988a](https://github.com/filecoin-project/filecoin-pin/commit/1d5988a8e2a6115025f285ffa76923c62e5d25dd))
* check ipni advertisement during upload ([#183](https://github.com/filecoin-project/filecoin-pin/issues/183)) ([b020a42](https://github.com/filecoin-project/filecoin-pin/commit/b020a42803dfaaf7945c32e52a6e83bf5d2b20dc))
* **ci:** handle duplicate items in add-to-project workflow ([#184](https://github.com/filecoin-project/filecoin-pin/issues/184)) ([0e80256](https://github.com/filecoin-project/filecoin-pin/commit/0e802564065b9139e36e860874a320f4c043f924))
* gh-action lints and typechecks on core changes ([#170](https://github.com/filecoin-project/filecoin-pin/issues/170)) ([107a023](https://github.com/filecoin-project/filecoin-pin/commit/107a0239877bc64fee8e43d35040e8209ae652eb))
* move gh-action logic to filecoin-pin/core ([#143](https://github.com/filecoin-project/filecoin-pin/issues/143)) ([ef6adc1](https://github.com/filecoin-project/filecoin-pin/commit/ef6adc12dd5c7dc951da17f74fae680fb06188f2))
* only typecheck upload-action in CI for now ([#196](https://github.com/filecoin-project/filecoin-pin/issues/196)) ([27e507c](https://github.com/filecoin-project/filecoin-pin/commit/27e507c709d3dcc8e6f1d4fa14d523bd53a81086))
* properly silence logging for CLI ([#195](https://github.com/filecoin-project/filecoin-pin/issues/195)) ([d25734d](https://github.com/filecoin-project/filecoin-pin/commit/d25734dad719cc0f33efde4730d07ff53c8d50a7))
* upload-flow renders correct spacing and IPNI info ([#191](https://github.com/filecoin-project/filecoin-pin/issues/191)) ([9a7a484](https://github.com/filecoin-project/filecoin-pin/commit/9a7a4845ad9134ce5151ed6aa638ceb1f53fa558))


### Chores

* improve telemetry docs/collecting ([#192](https://github.com/filecoin-project/filecoin-pin/issues/192)) ([ff8e07c](https://github.com/filecoin-project/filecoin-pin/commit/ff8e07c7a9666278bab45c1a8064ed23890a7675))
* move to the version of synapse-sdk on `next` branch ([#146](https://github.com/filecoin-project/filecoin-pin/issues/146)) ([528c6fa](https://github.com/filecoin-project/filecoin-pin/commit/528c6fac57d7582c77332c097058946a9d9852d2))


### Documentation

* link to more examples ([#181](https://github.com/filecoin-project/filecoin-pin/issues/181)) ([849b333](https://github.com/filecoin-project/filecoin-pin/commit/849b333b0ccb6ed2f7c0389f0ed12f239a13cdae))

## [0.10.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.10.0...v0.10.1) (2025-10-27)


### Chores

* s/FilOzone/filecoin-project ([#163](https://github.com/filecoin-project/filecoin-pin/issues/163)) ([0277e4d](https://github.com/filecoin-project/filecoin-pin/commit/0277e4de167e575e6ac2104da692b69b28d9af27))

## [0.10.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.9.2...v0.10.0) (2025-10-27)


### Features

* allow overriding withCDN via env-var ([#55](https://github.com/filecoin-project/filecoin-pin/issues/55)) ([0a89ca8](https://github.com/filecoin-project/filecoin-pin/commit/0a89ca8f9a8b30fccb5df51be926d84258f8afe8))


### Bug Fixes

* more ethers.js cleanup silencing ([#144](https://github.com/filecoin-project/filecoin-pin/issues/144)) ([785af4a](https://github.com/filecoin-project/filecoin-pin/commit/785af4ad6996f77afa9cebdc5fc66df866f5b089))
* withCDN data set creation ([#145](https://github.com/filecoin-project/filecoin-pin/issues/145)) ([86c839f](https://github.com/filecoin-project/filecoin-pin/commit/86c839f74b456279b9ffc9bdc89f6b0819413761))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.2.6 to 2.2.7 ([#150](https://github.com/filecoin-project/filecoin-pin/issues/150)) ([c29f2e6](https://github.com/filecoin-project/filecoin-pin/commit/c29f2e674c15779d6980afe761647b568566763b))
* **deps:** bump @filoz/synapse-sdk from 0.33.0 to 0.34.0 ([#149](https://github.com/filecoin-project/filecoin-pin/issues/149)) ([e9b7f07](https://github.com/filecoin-project/filecoin-pin/commit/e9b7f07dd4de3e771828d0ce5073e4fba3c9b544))
* **docs:** agents context file ([#139](https://github.com/filecoin-project/filecoin-pin/issues/139)) ([7c610a3](https://github.com/filecoin-project/filecoin-pin/commit/7c610a329ef6feb64048e2a3e69fc9e43a762610))


### Documentation

* add CONTRIBUTING.md and AGENTS.md ([#134](https://github.com/filecoin-project/filecoin-pin/issues/134)) ([5c204ed](https://github.com/filecoin-project/filecoin-pin/commit/5c204ed1f00eb2db16676225ad6e7b37c8e7af23))

## [0.9.2](https://github.com/filecoin-project/filecoin-pin/compare/v0.9.1...v0.9.2) (2025-10-17)


### Bug Fixes

* **action:** use fileSize to determine capacity when spendrate=0 ([#132](https://github.com/filecoin-project/filecoin-pin/issues/132)) ([f498169](https://github.com/filecoin-project/filecoin-pin/commit/f498169d3a304af14a8bdfef70544758640127ac))
* log level defaults to error for CLI ([#128](https://github.com/filecoin-project/filecoin-pin/issues/128)) ([cf851e5](https://github.com/filecoin-project/filecoin-pin/commit/cf851e547d33191566b9e45e7eef8e2746c9ab55))


### Chores

* **deps:** bump @helia/unixfs from 5.1.0 to 6.0.1 ([#94](https://github.com/filecoin-project/filecoin-pin/issues/94)) ([5ceb925](https://github.com/filecoin-project/filecoin-pin/commit/5ceb9250ff468c5001aa3a22b2987787d661e10f))


### Documentation

* **action:** Fix GitHub action version references from [@v1](https://github.com/v1) to [@v0](https://github.com/v0) ([#131](https://github.com/filecoin-project/filecoin-pin/issues/131)) ([2408783](https://github.com/filecoin-project/filecoin-pin/commit/240878373af58a66012e1e8287dd00fc6431a2e0))
* **action:** streamline README and remove duplication ([#136](https://github.com/filecoin-project/filecoin-pin/issues/136)) ([2d2b742](https://github.com/filecoin-project/filecoin-pin/commit/2d2b7428e01630c25e3da2db5de5c5c0df7a76df))

## [0.9.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.9.0...v0.9.1) (2025-10-16)


### Bug Fixes

* re-use upload-action PR comment ([#126](https://github.com/filecoin-project/filecoin-pin/issues/126)) ([e1cf5ec](https://github.com/filecoin-project/filecoin-pin/commit/e1cf5ec51f0b8853996e9fa3abbc2b6ed934681f)), closes [#99](https://github.com/filecoin-project/filecoin-pin/issues/99)
* upload-action provider overriding ([#116](https://github.com/filecoin-project/filecoin-pin/issues/116)) ([5a59dac](https://github.com/filecoin-project/filecoin-pin/commit/5a59dac8c27a0b2ef1e1d6b517df1d061a507ce0))
* use parseCLIAuth in add and import, add --warm-storage-address ([#123](https://github.com/filecoin-project/filecoin-pin/issues/123)) ([76bb790](https://github.com/filecoin-project/filecoin-pin/commit/76bb7909a16346ac0ca9a70f6a26cb69d5dc805f))


### Chores

* **deps:** bump actions/setup-node from 5 to 6 ([#121](https://github.com/filecoin-project/filecoin-pin/issues/121)) ([ebaabd6](https://github.com/filecoin-project/filecoin-pin/commit/ebaabd6951bad7329d004dfc5498eb2f2e97dcdc))
* **docs:** make README more accurate for current state ([#119](https://github.com/filecoin-project/filecoin-pin/issues/119)) ([dd0869b](https://github.com/filecoin-project/filecoin-pin/commit/dd0869b19de1ca5ec6890e03a6a30efba3e9a997))


### Documentation

* action example selects a random known good SP ([#125](https://github.com/filecoin-project/filecoin-pin/issues/125)) ([a23093b](https://github.com/filecoin-project/filecoin-pin/commit/a23093ba1988f7d071b0141aee81bf4389b3c3b4))
* **action:** Update Filecoin Pin Github Action README.md ([#118](https://github.com/filecoin-project/filecoin-pin/issues/118)) ([0df2e25](https://github.com/filecoin-project/filecoin-pin/commit/0df2e2558cb74a447aa2195950d34ab810a9da1c))
* **readme:** restructure and clarify project overview ([#124](https://github.com/filecoin-project/filecoin-pin/issues/124)) ([b3ce025](https://github.com/filecoin-project/filecoin-pin/commit/b3ce0258007d83d7f472fc85835d8e54eda7c033))

## [0.9.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.8.1...v0.9.0) (2025-10-14)


### Features

* add support for warm storage (env var only) and provider selection ([#102](https://github.com/filecoin-project/filecoin-pin/issues/102)) ([7f8eca9](https://github.com/filecoin-project/filecoin-pin/commit/7f8eca9b94bde227edc29a8b7b7830e0b14eacd3))


### Bug Fixes

* upgrade to latest synapse-sdk ([#115](https://github.com/filecoin-project/filecoin-pin/issues/115)) ([c99e370](https://github.com/filecoin-project/filecoin-pin/commit/c99e37036931d054c4127d44d10022a9e243a000))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.2.5 to 2.2.6 ([#112](https://github.com/filecoin-project/filecoin-pin/issues/112)) ([e8c4ce5](https://github.com/filecoin-project/filecoin-pin/commit/e8c4ce5221c5845601f20e38ec8b9980b4734492))

## [0.8.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.8.0...v0.8.1) (2025-10-13)


### Bug Fixes

* prevent some checks when using session key ([#110](https://github.com/filecoin-project/filecoin-pin/issues/110)) ([987c4cb](https://github.com/filecoin-project/filecoin-pin/commit/987c4cb6a64a4b23730bef4699cc497b012d9132))
* use correct addresses with session key auth ([#107](https://github.com/filecoin-project/filecoin-pin/issues/107)) ([9e05746](https://github.com/filecoin-project/filecoin-pin/commit/9e057464461589edf3cb0a8cd57857ebea1c6b12))
* use only ipni-enabled providers ([#109](https://github.com/filecoin-project/filecoin-pin/issues/109)) ([f642d6e](https://github.com/filecoin-project/filecoin-pin/commit/f642d6e6641a6d467eb11c0fbece46a9dcd7c4fc))

## [0.8.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.7.3...v0.8.0) (2025-10-13)


### Features

* add session key authentication support ([#103](https://github.com/filecoin-project/filecoin-pin/issues/103)) ([8ef8261](https://github.com/filecoin-project/filecoin-pin/commit/8ef82615c76924d7e154dd3f00126d94c385c180))
* create re-usable github action ([#60](https://github.com/filecoin-project/filecoin-pin/issues/60)) ([aa6b9bf](https://github.com/filecoin-project/filecoin-pin/commit/aa6b9bfc957bc59621606c1bad7e1a676b7fddaf))


### Bug Fixes

* cli supports session-key & wallet options ([#105](https://github.com/filecoin-project/filecoin-pin/issues/105)) ([e362531](https://github.com/filecoin-project/filecoin-pin/commit/e362531ccd17661c3ae745ef6c82939c740f6fbf))


### Chores

* **dev:** fix biome version ([#77](https://github.com/filecoin-project/filecoin-pin/issues/77)) ([dbf14be](https://github.com/filecoin-project/filecoin-pin/commit/dbf14be0ec0b52b88dd8282cf03b180ca67a370b))

## [0.7.3](https://github.com/filecoin-project/filecoin-pin/compare/v0.7.2...v0.7.3) (2025-10-09)


### Bug Fixes

* add auto-fund option ([#79](https://github.com/filecoin-project/filecoin-pin/issues/79)) ([c1e2f72](https://github.com/filecoin-project/filecoin-pin/commit/c1e2f72a2d7dfd4ae78c305063e9feb277fe3da9))
* createStorageContext supports multi-tenancy ([#93](https://github.com/filecoin-project/filecoin-pin/issues/93)) ([d47d3f3](https://github.com/filecoin-project/filecoin-pin/commit/d47d3f3f633e0972f21db3fe2153c49b4827a242))
* pass metadata through to executeUpload ([#89](https://github.com/filecoin-project/filecoin-pin/issues/89)) ([300ecd5](https://github.com/filecoin-project/filecoin-pin/commit/300ecd58f4132410c401a2dae45073975d98e9a2))

## [0.7.2](https://github.com/filecoin-project/filecoin-pin/compare/v0.7.1...v0.7.2) (2025-10-09)


### Bug Fixes

* avoid empty-directory block in directory CAR ([#85](https://github.com/filecoin-project/filecoin-pin/issues/85)) ([53fc7df](https://github.com/filecoin-project/filecoin-pin/commit/53fc7df58e5c31bfc72dd13e108d376ce7fdd2a4))

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
