# Releasing stooart

The publish workflow supports only version `0.1.0` from branch `release/0.1`. Define npm distribution tags for prereleases and maintenance releases before adding more versions, so an older build cannot replace `latest`.

The npm package contains compiled macOS and Linux executables, a Bun launcher, docs, examples, and agent skills. JSR publishes the Deno launcher in `launcher/jsr-mod.ts`, its CLI entry, and the same docs and skills. The launch function runs `stooart` from `PATH`, or an explicit executable path.

## Build and verify a candidate

| Event                                                 | Work                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pull request or `main` push                           | Linux checks for formatting, lint, types, and source tests                                                           |
| Push to `release/0.1` or manual CI run on that branch | The same checks, native builds and CLI tests on macOS arm64 and Linux x64, then candidate packaging and verification |
| Successful candidate workflow                         | Retains `release-<commit SHA>` for 90 days                                                                           |

Push the reviewed release commit to `release/0.1` and wait for its CI run to succeed. The candidate job builds the production archive from the two native artifacts, install-tests it, runs `deno publish --dry-run`, records hashes and source provenance, and uploads the release candidate. The publish workflow later downloads that exact artifact. It does not rebuild or repack it.

For a local native build, run `bun run build:native`. A production archive requires `dist/stooart-darwin-arm64`, `dist/stooart-linux-x64`, matching build provenance, and a clean committed tree.

`bun run release:pack` writes a candidate to `.stooart-release/`. It records binary and tarball SHA-256 hashes with relative filenames in `SHA256SUMS`, and records the source commit and Git state in `release-metadata.json`. Verify it with:

```sh
STOOART_EXPECTED_VERSION=<version> \
STOOART_EXPECTED_SOURCE_SHA=<commit> \
bun run release:verify .stooart-release/release-metadata.json .stooart-release/SHA256SUMS
```

For local packaging checks on one supported host, run `bun run pack:local`, then `bun run scripts/verify-package.ts <archive>`. That archive is marked private and contains only one host binary, so it cannot be released. The install check uses a fresh temporary Bun cache and exercises `--version` and a route fixture.

## Dispatch the release

After reviewing the successful candidate commit and artifact, open **Actions → Publish → Run workflow**. Select branch `release/0.1` and enter version `0.1.0`. The workflow rejects another branch, a version that differs from `package.json`, or a version beyond the currently supported `0.1.0`.

The verify job locates the successful push or manual CI run for that exact commit, downloads its unexpired `release-<commit SHA>` artifact, and checks its provenance, checksums, npm package installation, and JSR package dry run. The publish job downloads and verifies that same artifact again. It then waits for approval from the protected GitHub `release` environment before accessing registry publishing permissions. Configure required reviewers on that environment to keep this review gate active.

Dispatching the workflow starts verification. It does not itself mean npm or JSR has published. Publication begins only after verification succeeds and the `release` environment approves the publish job. The workflow publishes the tested npm archive and JSR sources in sequence, verifies both registry versions, then creates or completes the GitHub release. That final step creates tag `v0.1.0` through the GitHub API; tags do not trigger this workflow.

## Publishing setup

Builds, packaging, install checks, and scripts use Bun. npm publishing runs `npm@12.1.0` through `bunx --bun` for npm's trusted publishing and provenance support. Deno publishes JSR sources. The workflow installs no Node runtime.

Configure the protected `release/0.1` branch, required reviewers for the GitHub `release` environment, npm trusted publishing for `@compootor/stooart`, and JSR's GitHub connection. npm may need `NPM_TOKEN` in the `release` environment for its first publication. The token is optional. After npm trust is configured and verified, remove it. Never put tokens in repository files or command-line arguments.

The workflow's use of `id-token: write` permits npm and JSR trusted publishing. This repository change does not configure GitHub environments or registry trust, and local validation does not prove hosted publishing behavior.

## Resume a partial release

Rerun **Publish** from `release/0.1` with version `0.1.0`. The workflow reuses the earliest successful push or manual CI run for the exact commit and verifies the candidate again. It stops if that original artifact is missing, expired, or invalid. Do not rebuild the same commit as a substitute, since that does not prove the archive bytes match.

If npm already has the version, its integrity must match the candidate archive. If JSR already has the version, each published file checksum must match the source manifest, and the version cannot be yanked. A matching registry version is retained while the workflow publishes to the other registry. It verifies both registries before creating or finishing the GitHub release. An existing `v0.1.0` tag must point to the candidate's source commit, and every release asset is downloaded and compared byte-for-byte before the release is published.

Actions are pinned to verified commits. Dependabot proposes grouped weekly action updates; run normal PR checks before merging them.
