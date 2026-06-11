# Changelog

## [0.23.3](https://github.com/filecoin-project/filecoin-pin/compare/v0.23.2...v0.23.3) (2026-06-11)


### Features

* add session revoke command ([#518](https://github.com/filecoin-project/filecoin-pin/issues/518)) ([48b6f64](https://github.com/filecoin-project/filecoin-pin/commit/48b6f64d96cb63e97313c6912aaece6606352974))


### Bug Fixes

* run upload action test on push too ([#558](https://github.com/filecoin-project/filecoin-pin/issues/558)) ([7a996a5](https://github.com/filecoin-project/filecoin-pin/commit/7a996a58fdea57dbf17d7b56922ec6f5df02f78d))


### Documentation

* fix metadata table rendering in glossary ([#567](https://github.com/filecoin-project/filecoin-pin/issues/567)) ([aec3373](https://github.com/filecoin-project/filecoin-pin/commit/aec337383501fc05aea75f73487a679f80e7840f))
* pad test uploads past SP minimum size in DEVELOPMENT.md ([#571](https://github.com/filecoin-project/filecoin-pin/issues/571)) ([10b5dbe](https://github.com/filecoin-project/filecoin-pin/commit/10b5dbedff708c391c57886aff49df5ea5f0cb99))

## [0.23.2](https://github.com/filecoin-project/filecoin-pin/compare/v0.23.1...v0.23.2) (2026-06-09)


### Bug Fixes

* **ci:** pass absolute tarball path to npm publish ([#564](https://github.com/filecoin-project/filecoin-pin/issues/564)) ([b778404](https://github.com/filecoin-project/filecoin-pin/commit/b7784049a7e34676e5a35de7c88197f70694bcfb))

## [0.23.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.23.0...v0.23.1) (2026-06-09)


### Bug Fixes

* **ci:** override skip propagation on publish job ([#562](https://github.com/filecoin-project/filecoin-pin/issues/562)) ([a1b340b](https://github.com/filecoin-project/filecoin-pin/commit/a1b340bca5465f1dc3a4dfe8eba3ca8675c50a8d))

## [0.23.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.22.3...v0.23.0) (2026-06-08)


### ⚠ BREAKING CHANGES

* gate payments preflight on needed transactions ([#560](https://github.com/filecoin-project/filecoin-pin/issues/560))
* **core:** AuthorizeSessionProgressEvents no longer includes authorizeSession:resolving. Progress handlers should key on authorizeSession:submitting as the first event.
* the upload-action inputs minStorageDays and filecoinPayBalanceLimit are renamed to minRunwayDays and maxBalance. The old names remain as deprecated aliases for now and will be removed in a future release.
* **cli:** `rm --data-set` and the comma-separated `--provider-ids` / `--data-set-ids` flags are deprecated in favor of the repeatable `--provider-id` / `--data-set-id` flags.
* **payments:** `payments deposit --days` is removed. Use `payments fund --days N --mode minimum` to top up to a runway floor.
* **cli:** `rm --wait-for-confirmation` is deprecated in favor of `rm --wait`.

### Features

* **cli:** add data-set piece-status command, export reconcilePieceStatus ([#539](https://github.com/filecoin-project/filecoin-pin/issues/539)) ([666f862](https://github.com/filecoin-project/filecoin-pin/commit/666f862639e479ae716bb2606d7f7b74fd631287))
* **cli:** finish Option.env() rollout ([#554](https://github.com/filecoin-project/filecoin-pin/issues/554)) ([d6838c0](https://github.com/filecoin-project/filecoin-pin/commit/d6838c0b501a507d2601e9ee9c39b9c6e9ab5dab))
* **cli:** standardize confirmation-wait flag on --wait ([#541](https://github.com/filecoin-project/filecoin-pin/issues/541)) ([41a0a18](https://github.com/filecoin-project/filecoin-pin/commit/41a0a184ffff66af108d7e7e6d19c11edc17da11))
* **cli:** surface auth env var names in --help ([#536](https://github.com/filecoin-project/filecoin-pin/issues/536)) ([da6e33f](https://github.com/filecoin-project/filecoin-pin/commit/da6e33fdc96d4a2116e108e1b55be0bb86a0abd9))
* **cli:** unify data-set and provider ID flags ([#540](https://github.com/filecoin-project/filecoin-pin/issues/540)) ([1ca2438](https://github.com/filecoin-project/filecoin-pin/commit/1ca24387d761e7b7640ff55e19a6c7158a19dbac))
* **cli:** wire -v/--verbose to debug log level ([#534](https://github.com/filecoin-project/filecoin-pin/issues/534)) ([f14c22f](https://github.com/filecoin-project/filecoin-pin/commit/f14c22ff8e3a18933a6e57f9efc735ab8ee670eb))
* **core:** remove authorizeSession:resolving event ([#552](https://github.com/filecoin-project/filecoin-pin/issues/552)) ([9e72dc6](https://github.com/filecoin-project/filecoin-pin/commit/9e72dc6c2af79299316a3dafcfc2bb9ce08e7e5b))
* **payments:** make deposit one-way, fund sets targets ([#526](https://github.com/filecoin-project/filecoin-pin/issues/526)) ([0ede69e](https://github.com/filecoin-project/filecoin-pin/commit/0ede69e8fbc54d2fa35cf33f8cf7116ad122bfdc))
* **server:** GA cleanup for pinning server (beta) ([#531](https://github.com/filecoin-project/filecoin-pin/issues/531)) ([74784f8](https://github.com/filecoin-project/filecoin-pin/commit/74784f811672c8b6293ed8fc3843ef6bbddcdad0))
* upload-action docs, CLI recipe, and input rename ([#530](https://github.com/filecoin-project/filecoin-pin/issues/530)) ([f669b20](https://github.com/filecoin-project/filecoin-pin/commit/f669b20ba6d65c4049d70e08a4b4c8a1dfd28daa))


### Bug Fixes

* **cli:** distinct exit code 2 for cancelled or unconfirmed operations ([#533](https://github.com/filecoin-project/filecoin-pin/issues/533)) ([3074070](https://github.com/filecoin-project/filecoin-pin/commit/30740704ab0b2951c217960b0c0795e4c39f198f))
* **cli:** suppress update banner when stdout is not a TTY ([#535](https://github.com/filecoin-project/filecoin-pin/issues/535)) ([fc32696](https://github.com/filecoin-project/filecoin-pin/commit/fc32696a0691da33bd59024ee02049ca7610f580))
* **cli:** suppress update-available banner on non-TTY stdout ([fc32696](https://github.com/filecoin-project/filecoin-pin/commit/fc32696a0691da33bd59024ee02049ca7610f580))
* gate payments preflight on needed transactions ([#560](https://github.com/filecoin-project/filecoin-pin/issues/560)) ([f0e1a1a](https://github.com/filecoin-project/filecoin-pin/commit/f0e1a1ad3f0425e08baa2e22c82927db5dec545f))
* remove native node-datachannel dependency ([#556](https://github.com/filecoin-project/filecoin-pin/issues/556)) ([ac03180](https://github.com/filecoin-project/filecoin-pin/commit/ac03180dc98cf13ca8cccf49289d46a773384415))
* **server:** bind PORT and HOST env vars ([#555](https://github.com/filecoin-project/filecoin-pin/issues/555)) ([ecf23bb](https://github.com/filecoin-project/filecoin-pin/commit/ecf23bb92005f267317780a76b037991c25847a1))


### Chores

* **ci:** split build and publish jobs ([#514](https://github.com/filecoin-project/filecoin-pin/issues/514)) ([07baf9c](https://github.com/filecoin-project/filecoin-pin/commit/07baf9c48ec03978890d831b5f43bb3d8bae0d94))
* **deps-dev:** bump blockstore-core from 6.1.3 to 7.0.1 ([#551](https://github.com/filecoin-project/filecoin-pin/issues/551)) ([10a0a79](https://github.com/filecoin-project/filecoin-pin/commit/10a0a79d1415b31967171f986d26243048d839c6))
* **deps-dev:** bump typedoc from 0.28.18 to 0.28.19 ([#550](https://github.com/filecoin-project/filecoin-pin/issues/550)) ([657a453](https://github.com/filecoin-project/filecoin-pin/commit/657a453e3f5ed10de89643576f7fe2eefbf67860))
* **deps-dev:** bump typescript from 5.9.3 to 6.0.3 ([#549](https://github.com/filecoin-project/filecoin-pin/issues/549)) ([416f5c1](https://github.com/filecoin-project/filecoin-pin/commit/416f5c16f239c2e3c9e1c92c3b84606288e09641))
* **deps:** bump @clack/prompts from 1.2.0 to 1.4.0 ([#506](https://github.com/filecoin-project/filecoin-pin/issues/506)) ([76e110e](https://github.com/filecoin-project/filecoin-pin/commit/76e110e28bbde0b71c499519654e10e17145ca02))
* **deps:** bump @libp2p/identify from 4.1.2 to 4.1.6 ([#507](https://github.com/filecoin-project/filecoin-pin/issues/507)) ([a18cdf6](https://github.com/filecoin-project/filecoin-pin/commit/a18cdf653145b13e612d1d680695598359fcf5b2))
* **deps:** bump actions/add-to-project from 1.0.2 to 2.0.0 ([#544](https://github.com/filecoin-project/filecoin-pin/issues/544)) ([8480feb](https://github.com/filecoin-project/filecoin-pin/commit/8480febd53df707cbaf205b405003012bc095c4d))
* **deps:** bump actions/cache from 4 to 5 ([#546](https://github.com/filecoin-project/filecoin-pin/issues/546)) ([daf9acb](https://github.com/filecoin-project/filecoin-pin/commit/daf9acb9f1e32247fd395937be49bc7c2244d863))
* **deps:** bump actions/checkout from 6 to 6.0.2 ([#545](https://github.com/filecoin-project/filecoin-pin/issues/545)) ([da89475](https://github.com/filecoin-project/filecoin-pin/commit/da894752af52e027ee27b7016633bf9ace6d8f7e))
* **deps:** bump libp2p from 3.2.2 to 3.3.1 ([#508](https://github.com/filecoin-project/filecoin-pin/issues/508)) ([8fea640](https://github.com/filecoin-project/filecoin-pin/commit/8fea64089af4707b4b6cd462a58665e20b5e20f0))
* **deps:** bump pnpm/action-setup from 6.0.3 to 6.0.8 ([#543](https://github.com/filecoin-project/filecoin-pin/issues/543)) ([3a1b098](https://github.com/filecoin-project/filecoin-pin/commit/3a1b098c868763bf8316888d883d3e464284d6f2))
* **deps:** bump pnpm/action-setup from 6.0.3 to 6.0.8 in /upload-action ([#547](https://github.com/filecoin-project/filecoin-pin/issues/547)) ([88dae7c](https://github.com/filecoin-project/filecoin-pin/commit/88dae7c3a48c0f083f33b8d5408242c815f14889))
* **deps:** bump pnpm/action-setup in /upload-action ([88dae7c](https://github.com/filecoin-project/filecoin-pin/commit/88dae7c3a48c0f083f33b8d5408242c815f14889))


### Documentation

* add data retrieval guide, simplify gateway URLs in upload output ([174157e](https://github.com/filecoin-project/filecoin-pin/commit/174157e80e030ac80b82de0d07149ecd7d91a8b0))
* cross-link glossary and retrieval guide, add Piece CID / IPFS Root CID relationship section ([6cd8769](https://github.com/filecoin-project/filecoin-pin/commit/6cd87699a8055b8463df67c3025c308333729389))

## [0.22.3](https://github.com/filecoin-project/filecoin-pin/compare/v0.22.2...v0.22.3) (2026-06-01)


### Bug Fixes

* keep node-only devnet config out of browser bundles ([#520](https://github.com/filecoin-project/filecoin-pin/issues/520)) ([277e633](https://github.com/filecoin-project/filecoin-pin/commit/277e633049d847c8fca12bded5d80b437554afe8))

## [0.22.2](https://github.com/filecoin-project/filecoin-pin/compare/v0.22.1...v0.22.2) (2026-06-01)


### Features

* instrument multi-copy upload outcomes ([#501](https://github.com/filecoin-project/filecoin-pin/issues/501)) ([b3ef48e](https://github.com/filecoin-project/filecoin-pin/commit/b3ef48e25873aa806cb8eb73bc69ef4e38bcd589))


### Chores

* **deps:** bump @libp2p/tcp from 11.0.17 to 11.0.20 ([#510](https://github.com/filecoin-project/filecoin-pin/issues/510)) ([0a50ad0](https://github.com/filecoin-project/filecoin-pin/commit/0a50ad053d3703c77e803e3b0f9c00412f514294))

## [0.22.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.22.0...v0.22.1) (2026-05-28)


### Bug Fixes

* **ci:** add manual npm publish dispatch ([#512](https://github.com/filecoin-project/filecoin-pin/issues/512)) ([51f88ee](https://github.com/filecoin-project/filecoin-pin/commit/51f88eebe0ba6fcbfb5738a8b1a916ee1cdd5899))

## [0.22.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.21.0...v0.22.0) (2026-05-27)


### ⚠ BREAKING CHANGES

* **payments:** Multiple public API changes in @filoz/filecoin-pin/core/payments:
    - calculateStorageRunway removed; use deriveStorageRunway / getStorageRunway.
    - StorageRunwaySummary fields renamed: {days, hours, available} ->
      {runwayDays, runwayHours, coverageDays, coverageHours}.
    - computeAdjustmentForExactDays{,WithPiece}, computeTopUpForDuration,
      computeAdjustmentForExactDeposit signatures changed from (status, ...)
      to (accountSummary, balance, ...).
    - getFilecoinPayFundingInsights now requires an accountSummary argument.
    - calculateFilecoinPayFundingPlan options now require accountSummary.
    - PaymentStatus.filecoinPayBalance is now gross deposit (was availableFunds).
    - formatRunwaySummary returns {coverage, runway} strings instead of one string.
    - upload-action SimplifiedPaymentStatus adds required storageCovered.
* **unixfs:** `add` now produces different root CIDs than prior versions for single-file inputs (no directory wrapper) and may produce different CIDs for directories crossing the 256 KiB HAMT threshold (now estimated by serialized block size per the spec). The `--bare` flag is removed; the new profile makes it the only behavior.

### refactor

* **payments:** harmonize runway/coverage with synapse-sdk 0.41.0 ([#412](https://github.com/filecoin-project/filecoin-pin/issues/412)) ([3bdadd7](https://github.com/filecoin-project/filecoin-pin/commit/3bdadd769d370871cad6f70660e4d14278f97369))


### Features

* accept 'calibnet' as alias for --network calibration ([#482](https://github.com/filecoin-project/filecoin-pin/issues/482)) ([1c044dd](https://github.com/filecoin-project/filecoin-pin/commit/1c044dd5e89ab697ebcebe9e704f006fe862c166))
* create session keys with filecoin-pin ([#215](https://github.com/filecoin-project/filecoin-pin/issues/215)) ([7c73a98](https://github.com/filecoin-project/filecoin-pin/commit/7c73a980123f02ba230c54c7bffef5a2dd229482))
* **unixfs:** adopt IPIP-499 unixfs-v1-2025 profile ([#448](https://github.com/filecoin-project/filecoin-pin/issues/448)) ([2990d30](https://github.com/filecoin-project/filecoin-pin/commit/2990d3052ac4de016a1ec8156b692c6e0683dfb8))
* **upload-action:** default network to mainnet ([#489](https://github.com/filecoin-project/filecoin-pin/issues/489)) ([6ff233a](https://github.com/filecoin-project/filecoin-pin/commit/6ff233ae34b3e66936a773b8adfc6276ee24fff1))


### Bug Fixes

* get detailed data set avoid full scan ([#483](https://github.com/filecoin-project/filecoin-pin/issues/483)) ([1e86afc](https://github.com/filecoin-project/filecoin-pin/commit/1e86afcf5c630bf47387835c5146cca6ba320920))
* **payments:** size auto-setup by available funds ([#505](https://github.com/filecoin-project/filecoin-pin/issues/505)) ([11506d2](https://github.com/filecoin-project/filecoin-pin/commit/11506d2d9aac7288a8cddd7fadbbb5266fd54a41))
* stream remaining upload paths and expose upload progress ([#441](https://github.com/filecoin-project/filecoin-pin/issues/441)) ([9437cce](https://github.com/filecoin-project/filecoin-pin/commit/9437cce75b46ba148ef3e309864abc5c33c8ee0e))


### Chores

* **deps-dev:** bump @ipld/dag-cbor from 9.2.5 to 9.2.6 ([#479](https://github.com/filecoin-project/filecoin-pin/issues/479)) ([ef4c972](https://github.com/filecoin-project/filecoin-pin/commit/ef4c972c987d9b113c5c2e3abe237ca0d82cb177))
* **deps-dev:** bump typedoc from 0.28.18 to 0.28.19 ([#493](https://github.com/filecoin-project/filecoin-pin/issues/493)) ([cafe764](https://github.com/filecoin-project/filecoin-pin/commit/cafe76474718175be6348fe98311bd6626979d8f))
* **deps:** bump @actions/core from 3.0.0 to 3.0.1 ([#475](https://github.com/filecoin-project/filecoin-pin/issues/475)) ([a81c3a6](https://github.com/filecoin-project/filecoin-pin/commit/a81c3a6a4dfdd7ba3732e7a5112a4717ed355714))
* **deps:** bump @libp2p/kad-dht from 16.2.4 to 16.2.6 ([#499](https://github.com/filecoin-project/filecoin-pin/issues/499)) ([4e4033c](https://github.com/filecoin-project/filecoin-pin/commit/4e4033c45006d8622b5fda41a3859538911fc897))
* **deps:** bump @multiformats/multiaddr from 13.0.1 to 13.0.3 ([#492](https://github.com/filecoin-project/filecoin-pin/issues/492)) ([689b724](https://github.com/filecoin-project/filecoin-pin/commit/689b724e93be705d767721d277085d35e2993ec2))
* **deps:** bump brace-expansion from 5.0.5 to 5.0.6 ([#497](https://github.com/filecoin-project/filecoin-pin/issues/497)) ([6b69159](https://github.com/filecoin-project/filecoin-pin/commit/6b691593d1f25344936412b061a67b78088dfc3c))
* **deps:** bump interface-store from 7.0.1 to 7.0.2 ([#476](https://github.com/filecoin-project/filecoin-pin/issues/476)) ([dad5c4d](https://github.com/filecoin-project/filecoin-pin/commit/dad5c4d4ef4581ef542b0e311568e1deca124299))
* **deps:** bump semver from 7.7.4 to 7.8.0 ([#494](https://github.com/filecoin-project/filecoin-pin/issues/494)) ([301d8d1](https://github.com/filecoin-project/filecoin-pin/commit/301d8d10889ec0ecea739b3c75d0e0d94394bfb8))
* **deps:** bump ws from 8.18.3 to 8.20.1 ([#498](https://github.com/filecoin-project/filecoin-pin/issues/498)) ([9c9fc7c](https://github.com/filecoin-project/filecoin-pin/commit/9c9fc7c3da40afc57a4595267a0c6b57cad26ab8))
* **deps:** update @types/node and @helia/unixfs ([#491](https://github.com/filecoin-project/filecoin-pin/issues/491)) ([8bea6fb](https://github.com/filecoin-project/filecoin-pin/commit/8bea6fb152c2edf3e75a3fc7daafda8160110514))
* **deps:** update helia & reconcile conflicting deps ([71d5530](https://github.com/filecoin-project/filecoin-pin/commit/71d5530b876353530a6f0a611366fdad2dcb96e1))
* label browser vs raw-asset gateway URLs in upload output ([#503](https://github.com/filecoin-project/filecoin-pin/issues/503)) ([772a4dd](https://github.com/filecoin-project/filecoin-pin/commit/772a4dd430dc08b9b0ad758b1a6ac054091fec89))


### Documentation

* fix cli link in README ([#484](https://github.com/filecoin-project/filecoin-pin/issues/484)) ([00c9a29](https://github.com/filecoin-project/filecoin-pin/commit/00c9a29b70b5d3f886ef67f588d705a16895f1db))
* holistic documentation improvements for mainnet GA ([#466](https://github.com/filecoin-project/filecoin-pin/issues/466)) ([a15839c](https://github.com/filecoin-project/filecoin-pin/commit/a15839cce9f23632e0ae52edefc0fecc5a51981e))

## [0.21.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.20.1...v0.21.0) (2026-05-07)


### ⚠ BREAKING CHANGES

* **synapse:** CLI commands now use Filecoin Mainnet when --network/NETWORK is omitted. Use --network calibration or NETWORK=calibration for Calibration testnet.
* rename onProgress event types ([#456](https://github.com/filecoin-project/filecoin-pin/issues/456))
* **cli:** CLI commands now use Filecoin Mainnet when --network/NETWORK is omitted. Use --network calibration or NETWORK=calibration for Calibration testnet.

### refactor

* rename onProgress event types ([#456](https://github.com/filecoin-project/filecoin-pin/issues/456)) ([4f6e59b](https://github.com/filecoin-project/filecoin-pin/commit/4f6e59bdaccfb84487bafca1d2a276bf753a54fd))


### Features

* **cli:** default network to mainnet ([#445](https://github.com/filecoin-project/filecoin-pin/issues/445)) ([2b07899](https://github.com/filecoin-project/filecoin-pin/commit/2b07899866a57feb2459b21516abdcd0de934e12))
* detect CAR input in add and refuse to wrap ([#459](https://github.com/filecoin-project/filecoin-pin/issues/459)) ([dac8326](https://github.com/filecoin-project/filecoin-pin/commit/dac83262ee4ff9fdc88652388e613567abab9013))
* **synapse:** derive chain from RPC probe ([#455](https://github.com/filecoin-project/filecoin-pin/issues/455)) ([8e20261](https://github.com/filecoin-project/filecoin-pin/commit/8e202612a5d9e90d7fd338419888e43de7075357))


### Bug Fixes

* **ci:** stabilize Windows test runner ([#462](https://github.com/filecoin-project/filecoin-pin/issues/462)) ([5b10174](https://github.com/filecoin-project/filecoin-pin/commit/5b101749bea53614199cdffadf923b75b0ed0d8b))
* **server:** pass resolved chain to Synapse ([#446](https://github.com/filecoin-project/filecoin-pin/issues/446)) ([1823eab](https://github.com/filecoin-project/filecoin-pin/commit/1823eabaa321941f48e96d8f83b66b29015aa975))


### Chores

* **deps-dev:** bump blockstore-core from 6.1.2 to 6.1.3 ([#452](https://github.com/filecoin-project/filecoin-pin/issues/452)) ([eb00247](https://github.com/filecoin-project/filecoin-pin/commit/eb00247444cb11c580929febea49604bcf9031ab))
* **deps:** bump @helia/block-brokers from 5.1.4 to 5.2.4 ([#450](https://github.com/filecoin-project/filecoin-pin/issues/450)) ([77e5ba3](https://github.com/filecoin-project/filecoin-pin/commit/77e5ba3b3525a6fb5d0ebca84b555d2402738889))
* **deps:** bump @ipld/car from 5.4.2 to 5.4.3 ([#453](https://github.com/filecoin-project/filecoin-pin/issues/453)) ([38c6cfd](https://github.com/filecoin-project/filecoin-pin/commit/38c6cfdf04790cb8c2cb8de16f7d388223669cf5))
* **deps:** bump viem from 2.48.3 to 2.48.4 ([#449](https://github.com/filecoin-project/filecoin-pin/issues/449)) ([6f93058](https://github.com/filecoin-project/filecoin-pin/commit/6f93058a32ed96f91d154cd2880112ad03077c40))

## [0.20.1](https://github.com/filecoin-project/filecoin-pin/compare/v0.20.0...v0.20.1) (2026-05-04)


### Features

* **add,import:** resolve --data-set-metadata to existing dataset IDs ([#438](https://github.com/filecoin-project/filecoin-pin/issues/438)) ([495a734](https://github.com/filecoin-project/filecoin-pin/commit/495a7342a1b9e1a1846f5715418a0d25fd78de2e))
* **cli:** add --min-runway-days and --max-balance to --auto-fund ([#433](https://github.com/filecoin-project/filecoin-pin/issues/433)) ([2cd9026](https://github.com/filecoin-project/filecoin-pin/commit/2cd9026902f0372aecf647a8d38f6ad9a845c5df))
* **server:** check optional bearer access token ([#382](https://github.com/filecoin-project/filecoin-pin/issues/382)) ([67ee879](https://github.com/filecoin-project/filecoin-pin/commit/67ee87940386c34a124e7b00a12f08cf0a54fcc7))
* **server:** Session Key support in server mode ([#376](https://github.com/filecoin-project/filecoin-pin/issues/376)) ([0d104c8](https://github.com/filecoin-project/filecoin-pin/commit/0d104c83fd17a648256e7ded441e8d40f8102d72))
* support stream uploads to Synapse ([#428](https://github.com/filecoin-project/filecoin-pin/issues/428)) ([63ab93c](https://github.com/filecoin-project/filecoin-pin/commit/63ab93cfb6eea6ee8278f1fd5604ca6d785e235b))
* test upload-action in ci. closes [#395](https://github.com/filecoin-project/filecoin-pin/issues/395) ([#399](https://github.com/filecoin-project/filecoin-pin/issues/399)) ([9850814](https://github.com/filecoin-project/filecoin-pin/commit/9850814945387f5dcbabecafeef121bcf1ef76d9))
* **upload-action:** accept pre-built .car path ([#410](https://github.com/filecoin-project/filecoin-pin/issues/410)) ([65b9f2c](https://github.com/filecoin-project/filecoin-pin/commit/65b9f2c65ad1228358215cbd0a6e1ac4fc68b0bf))


### Bug Fixes

* **dataset-list:** honor explicit metadata/provider filter ([#434](https://github.com/filecoin-project/filecoin-pin/issues/434)) ([eaf22e4](https://github.com/filecoin-project/filecoin-pin/commit/eaf22e49748768d971594d23a6c4aeb37cf02d9b))
* exit after successful run ([9850814](https://github.com/filecoin-project/filecoin-pin/commit/9850814945387f5dcbabecafeef121bcf1ef76d9))
* **identify:** handle many origins ([#386](https://github.com/filecoin-project/filecoin-pin/issues/386)) ([1a80f7d](https://github.com/filecoin-project/filecoin-pin/commit/1a80f7d2cca64bf9ef7378472a6d61e6fbbfffa2))
* reset pnpm-lock.yaml after dependabot rebase mess-up ([#416](https://github.com/filecoin-project/filecoin-pin/issues/416)) ([355e0ef](https://github.com/filecoin-project/filecoin-pin/commit/355e0ef88c823ec37ed2e58f5e99d9d3b504e4c5)), closes [#405](https://github.com/filecoin-project/filecoin-pin/issues/405)
* sync libp2p deps ([#406](https://github.com/filecoin-project/filecoin-pin/issues/406)) ([3ba56f0](https://github.com/filecoin-project/filecoin-pin/commit/3ba56f09a8ea3bceb7aed5ea0ed291ee5d81cdb7))
* tolerate PR comment failures ([9850814](https://github.com/filecoin-project/filecoin-pin/commit/9850814945387f5dcbabecafeef121bcf1ef76d9))
* **upload-action:** repair pnpm caching broken by step ordering ([#418](https://github.com/filecoin-project/filecoin-pin/issues/418)) ([9acd55a](https://github.com/filecoin-project/filecoin-pin/commit/9acd55a665560f3d04c8d54044a6458435ea2915))
* use synapse-core sybil fee constants ([9850814](https://github.com/filecoin-project/filecoin-pin/commit/9850814945387f5dcbabecafeef121bcf1ef76d9))


### Chores

* **ci:** pin third-party actions to SHA, bump release-please-action v4 → v5.0.0 ([#413](https://github.com/filecoin-project/filecoin-pin/issues/413)) ([725a486](https://github.com/filecoin-project/filecoin-pin/commit/725a4863ab7be39321184c4eb2f741e9ff12e99a))
* **dependabot:** check and update /upload-action deps too ([#420](https://github.com/filecoin-project/filecoin-pin/issues/420)) ([3ffa9bf](https://github.com/filecoin-project/filecoin-pin/commit/3ffa9bf9d80671dfd5d0a94d8f5eb5c79967a2c2))
* **deps-dev:** bump typedoc from 0.28.17 to 0.28.18 ([#407](https://github.com/filecoin-project/filecoin-pin/issues/407)) ([af3aa2c](https://github.com/filecoin-project/filecoin-pin/commit/af3aa2ce2525119eedcdcde7077891d8f1121add))
* **deps:** bump @clack/prompts from 1.1.0 to 1.2.0 ([#405](https://github.com/filecoin-project/filecoin-pin/issues/405)) ([b9cf6bb](https://github.com/filecoin-project/filecoin-pin/commit/b9cf6bb681804ddc962e2f11e0d88b2b50d0aa85))
* **deps:** bump @helia/block-brokers from 5.1.3 to 5.1.4 ([#387](https://github.com/filecoin-project/filecoin-pin/issues/387)) ([b4964dc](https://github.com/filecoin-project/filecoin-pin/commit/b4964dc6b737a2bd9c2eb003a9cba2bf9082db1e))
* **deps:** bump @helia/unixfs from 7.0.4 to 7.1.0 ([#391](https://github.com/filecoin-project/filecoin-pin/issues/391)) ([27941cd](https://github.com/filecoin-project/filecoin-pin/commit/27941cde7618037397516df0c11c9e461358f212))
* **deps:** bump @sentry/node from 10.43.0 to 10.45.0 ([#390](https://github.com/filecoin-project/filecoin-pin/issues/390)) ([abcbf19](https://github.com/filecoin-project/filecoin-pin/commit/abcbf196461d7b808a5a5b8866ba7504f4e0083b))
* **deps:** bump @sentry/node from 10.46.0 to 10.49.0 ([6c405c9](https://github.com/filecoin-project/filecoin-pin/commit/6c405c92564fb6823e123eb23e3d70c17377f6e6))
* **deps:** bump actions/cache from 4 to 5 in /upload-action ([#440](https://github.com/filecoin-project/filecoin-pin/issues/440)) ([c81f46d](https://github.com/filecoin-project/filecoin-pin/commit/c81f46dd9a6498f31b606e84538fbf04ed90532e))
* **deps:** bump actions/configure-pages from 5 to 6 ([#397](https://github.com/filecoin-project/filecoin-pin/issues/397)) ([c70fde4](https://github.com/filecoin-project/filecoin-pin/commit/c70fde4e131d294c9e30fe6ac4df9a52319fa392))
* **deps:** bump actions/deploy-pages from 4 to 5 ([#396](https://github.com/filecoin-project/filecoin-pin/issues/396)) ([b757b1b](https://github.com/filecoin-project/filecoin-pin/commit/b757b1b77f7942e5a423014c346b48225ada84b0))
* **deps:** bump actions/github-script from 7 to 9 in /upload-action ([#422](https://github.com/filecoin-project/filecoin-pin/issues/422)) ([5066b60](https://github.com/filecoin-project/filecoin-pin/commit/5066b600179ea8fdb776fe8e8d89c60235ccae1a))
* **deps:** bump actions/github-script from 8 to 9 ([#423](https://github.com/filecoin-project/filecoin-pin/issues/423)) ([3454dbf](https://github.com/filecoin-project/filecoin-pin/commit/3454dbfc143b0fab130d9095fe8fe6fce0d27280))
* **deps:** bump actions/upload-pages-artifact from 4 to 5 ([#424](https://github.com/filecoin-project/filecoin-pin/issues/424)) ([01c0b99](https://github.com/filecoin-project/filecoin-pin/commit/01c0b9956f4eacfa634ebba8a92d66b8a85d0049))
* **deps:** bump fastify from 5.8.2 to 5.8.4 ([#389](https://github.com/filecoin-project/filecoin-pin/issues/389)) ([efb5889](https://github.com/filecoin-project/filecoin-pin/commit/efb5889676a2fdda22a65e180643811fb82929be))
* **deps:** bump fastify from 5.8.4 to 5.8.5 ([930f3a3](https://github.com/filecoin-project/filecoin-pin/commit/930f3a3cff67b8dcb803eb87f93b713920cd1da4))
* **deps:** bump googleapis/release-please-action from 4 to 5 ([#426](https://github.com/filecoin-project/filecoin-pin/issues/426)) ([01ca938](https://github.com/filecoin-project/filecoin-pin/commit/01ca9383bd5875be01c6c0e649887796c892d7d7))
* **deps:** bump helia from 6.0.21 to 6.0.22 ([#388](https://github.com/filecoin-project/filecoin-pin/issues/388)) ([2f40e9b](https://github.com/filecoin-project/filecoin-pin/commit/2f40e9bb93ae6471e5352bb2470884ca9697bfef))
* **deps:** bump pnpm/action-setup from 4 to 5 ([#398](https://github.com/filecoin-project/filecoin-pin/issues/398)) ([51c3e9a](https://github.com/filecoin-project/filecoin-pin/commit/51c3e9a96dda449fbf9531514f38ea34b4b8cb9e))
* **deps:** bump pnpm/action-setup from 5.0.0 to 6.0.3 ([#425](https://github.com/filecoin-project/filecoin-pin/issues/425)) ([81a526f](https://github.com/filecoin-project/filecoin-pin/commit/81a526fcddd891fcf05a2143ed9961dcda165bee))
* **deps:** bump synapse-sdk to 0.40.4 + synapse-core to 0.4.1 ([#419](https://github.com/filecoin-project/filecoin-pin/issues/419)) ([0e3aa6f](https://github.com/filecoin-project/filecoin-pin/commit/0e3aa6fb65c68f8102d0966cc2eccefd97168358))
* **deps:** bump viem from 2.47.2 to 2.48.2 ([ba18f62](https://github.com/filecoin-project/filecoin-pin/commit/ba18f62a6b409c1c93f7f633687ff781b2dab236))
* **docs:** add development docs ([#408](https://github.com/filecoin-project/filecoin-pin/issues/408)) ([d6df4cb](https://github.com/filecoin-project/filecoin-pin/commit/d6df4cbe1b5cb34ca56b8250f13d3420872dd93b))
* tighten dry-run workflow permissions ([9850814](https://github.com/filecoin-project/filecoin-pin/commit/9850814945387f5dcbabecafeef121bcf1ef76d9))

## [0.20.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.19.0...v0.20.0) (2026-03-31)


### Bug Fixes

* **core,dx:** contexts in executeUpload, provider targeting docs, pass 'source' option through ([#373](https://github.com/filecoin-project/filecoin-pin/issues/373)) ([b307beb](https://github.com/filecoin-project/filecoin-pin/commit/b307beb7cb08e03533567f7dabccfdea795ccedb))


### Chores

* **deps:** bump @libp2p/identify from 4.0.12 to 4.0.13 ([#381](https://github.com/filecoin-project/filecoin-pin/issues/381)) ([b4cb693](https://github.com/filecoin-project/filecoin-pin/commit/b4cb6933a7b78f10dd97252ce05331dd1e26f72e))
* **deps:** bump @libp2p/tcp from 11.0.12 to 11.0.13 ([#378](https://github.com/filecoin-project/filecoin-pin/issues/378)) ([2e386d2](https://github.com/filecoin-project/filecoin-pin/commit/2e386d2c1e6b2814633bf7c610aaf0482e7b3196))
* **deps:** bump @sentry/node from 10.43.0 to 10.44.0 ([#377](https://github.com/filecoin-project/filecoin-pin/issues/377)) ([95d4386](https://github.com/filecoin-project/filecoin-pin/commit/95d43866625325273b10c66b44c5e525187b73a4))
* **deps:** bump libp2p from 3.1.5 to 3.1.6 ([#379](https://github.com/filecoin-project/filecoin-pin/issues/379)) ([f594bfe](https://github.com/filecoin-project/filecoin-pin/commit/f594bfeafb2ff76286dda334211d0b5aeb93abb5))
* **deps:** bump viem from 2.47.2 to 2.47.4 ([#380](https://github.com/filecoin-project/filecoin-pin/issues/380)) ([1d4e59b](https://github.com/filecoin-project/filecoin-pin/commit/1d4e59bee06e3c0710fd20a2e836716c7f3d923e))
* release 0.20.0 ([baef391](https://github.com/filecoin-project/filecoin-pin/commit/baef3914fb3b99115fdf9cdb7118e206210c37bc))

## [1.0.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.18.0...v1.0.0) (2026-03-20)


### ⚠ BREAKING CHANGES

* compare IPNI providers as normalized URIs ([#368](https://github.com/filecoin-project/filecoin-pin/issues/368))
* update to synapse-sdk@0.40.0 ([#369](https://github.com/filecoin-project/filecoin-pin/issues/369))

### Features

* update to synapse-sdk@0.40.0 ([#369](https://github.com/filecoin-project/filecoin-pin/issues/369)) ([83da89d](https://github.com/filecoin-project/filecoin-pin/commit/83da89de16c8a6dd48ec77a293b3d9d686a4d08c))


### Bug Fixes

* compare IPNI providers as normalized URIs ([#368](https://github.com/filecoin-project/filecoin-pin/issues/368)) ([7994400](https://github.com/filecoin-project/filecoin-pin/commit/7994400213c96fea0c4faede729c74b9865251c2))
* use pnpm ([#370](https://github.com/filecoin-project/filecoin-pin/issues/370)) ([6563a33](https://github.com/filecoin-project/filecoin-pin/commit/6563a33654ad1b571be4e48b78a53e30601d6922))


### Chores

* 7day dep update cooldown, use `npm ci` for stable install in action ([#359](https://github.com/filecoin-project/filecoin-pin/issues/359)) ([56d5f69](https://github.com/filecoin-project/filecoin-pin/commit/56d5f69bc27f3a26caea57f3251972f5cb4de40b))
* **deps:** bump undici from 6.23.0 to 6.24.1 in /upload-action ([#361](https://github.com/filecoin-project/filecoin-pin/issues/361)) ([ef7062f](https://github.com/filecoin-project/filecoin-pin/commit/ef7062fdcf539b4b533f82b7d128e1c1a148f5c7))
* **docs:** changelog tweak ([#355](https://github.com/filecoin-project/filecoin-pin/issues/355)) ([751032f](https://github.com/filecoin-project/filecoin-pin/commit/751032f2e4939039d00e13f971297358827903e6))


### Documentation

* add a security policy ([#358](https://github.com/filecoin-project/filecoin-pin/issues/358)) ([79a8a9a](https://github.com/filecoin-project/filecoin-pin/commit/79a8a9a180c615aa245cb265037d63310bd87321))

## [0.18.0](https://github.com/filecoin-project/filecoin-pin/compare/v0.17.0...v0.18.0) (2026-03-10)

This release introduces **multi-copy storage** for data durability. Uploads now automatically store 2 copies of your data across independent Filecoin storage providers. Each copy is independently proven on-chain, so a single provider failure doesn't result in data loss. The number of copies can be controlled with `--count`, and you only upload your data once regardless of copy count.

Also fixes `--mainnet` support across the CLI, a `terminate` command for dataset lifecycle management, and local devnet support for development.


### Features

* **multi-copy storage:** uploads now create 2 independently-proven copies across different storage providers by default for data durability (synapse-sdk 0.38, synapse-core 0.2) ([#343](https://github.com/filecoin-project/filecoin-pin/issues/343)) ([9a87038](https://github.com/filecoin-project/filecoin-pin/commit/9a870383119bc6902ff66501cca31e21afc129b3))
* **provider selection:** target specific providers with `--provider-ids` or specific data sets with `--data-set-ids`, and control copy count with `--count` ([#343](https://github.com/filecoin-project/filecoin-pin/issues/343))
* add `terminate` command to terminate a dataset ([#307](https://github.com/filecoin-project/filecoin-pin/issues/307)) ([50179c2](https://github.com/filecoin-project/filecoin-pin/commit/50179c2d4cb598a700ca21985033087b9c30b8fd))
* add devnet network support and `--skip-ipni-verification` flag ([#354](https://github.com/filecoin-project/filecoin-pin/issues/354)) ([f4eb4fc](https://github.com/filecoin-project/filecoin-pin/commit/f4eb4fca0b303b290bcb776de50b4cb10a94e1de))


### Bug Fixes

* support mainnet CLI network and payment guidance ([#353](https://github.com/filecoin-project/filecoin-pin/issues/353)) ([3e4e330](https://github.com/filecoin-project/filecoin-pin/commit/3e4e330064e2383ac5b8415656bb4ce5e8ab6b8b))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.4.4 to 2.4.5 ([#346](https://github.com/filecoin-project/filecoin-pin/issues/346)) ([43fd0ce](https://github.com/filecoin-project/filecoin-pin/commit/43fd0ce79877ad0ae0bcaca7e0b5e073fdbeb3a8))

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
