# Releasing stooart

The publish workflow supports version `0.1.1` from branch `release/0.1`. The earlier GitHub release `v0.1.0` keeps its original assets. Define npm distribution tags for prereleases and maintenance releases before adding more versions, so an older build cannot replace `latest`.

The root npm package contains a Node.js launcher, docs, examples, and agent skills. It selects `@compootor/stooart-darwin-arm64` or `@compootor/stooart-linux-x64` through optional dependencies. Each platform package contains only its matching executable and declares matching `os` and `cpu` restrictions. GitHub releases include the small root archive and both compressed platform archives, without a second copy of the raw executables. JSR publishes the Deno launcher in `launcher/jsr-mod.ts`, its CLI entry, and the same docs and skills. The launch function runs `stooart` from `PATH`, or an explicit executable path.

## Build and verify a candidate

| Event                                                 | Work                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pull request or `main` push                           | Linux checks for formatting, lint, types, and source tests                                                           |
| Push to `release/0.1` or manual CI run on that branch | The same checks, native builds and CLI tests on macOS arm64 and Linux x64, then candidate packaging and verification |
| Successful candidate workflow                         | Retains `release-<commit SHA>` for 90 days                                                                           |

Push the reviewed release commit to `release/0.1` and wait for its CI run to succeed. The candidate job builds the production archive from the two native artifacts, install-tests it, runs `deno publish --dry-run`, records hashes and source provenance, and uploads the release candidate. The publish workflow later downloads that exact artifact. It does not rebuild or repack it.

For a local native build, run `pnpm build:native`. A production archive requires `dist/stooart-darwin-arm64`, `dist/stooart-linux-x64`, matching build provenance, and a clean committed tree.

The build bundles the application with Vite+, then compiles a package entry with scriptc's C backend in dynamic mode. The executable embeds QuickJS and the Effect application. It needs no installed Node.js or Bun, but the application is not translated entirely into static C. Building requires a C toolchain. Provenance records the compiler version, backend, dynamic mode, artifact size, and checksum.

The pinned pnpm patches repair scriptc's TypeScript filesystem integration, remove local paths from TLS library builds, and bridge the Node APIs used by Effect for streams, child processes, signals, terminal input, and file append modes. Keep the patches with the lockfile. After changing them or upgrading scriptc, run `pnpm check`, `pnpm build:native`, `pnpm test:native`, and the package install check. Also check hidden credential entry and cancellation in a real terminal.

`pnpm release:pack` writes a candidate to `.stooart-release/`. It records hashes for all three npm archives in `SHA256SUMS`, and records the source commit and Git state in `release-metadata.json`. Verify it with:

```sh
STOOART_EXPECTED_VERSION=<version> \
STOOART_EXPECTED_SOURCE_SHA=<commit> \
pnpm release:verify .stooart-release/release-metadata.json .stooart-release/SHA256SUMS
```

For local packaging checks on one supported host, run `pnpm pack:local`, then pass the root and matching platform archive to `pnpm exec node --experimental-strip-types scripts/verify-package.ts <root-archive> <platform-archive>`. The root archive has no executable. The host package contains one executable and is marked for that host. The install check uses npm with a fresh temporary cache, then exercises `--version` and a route fixture.

## Dispatch the release

After reviewing the successful candidate commit and artifact, open **Actions → Publish → Run workflow**. Select branch `release/0.1` and enter version `0.1.1`. The workflow rejects another branch, a version that differs from `package.json`, or a version beyond the currently supported `0.1.1`.

The verify job locates the successful push or manual CI run for that exact commit, downloads its unexpired `release-<commit SHA>` artifact, and checks its provenance, checksums, npm package installation, and JSR package dry run. The publish job downloads and verifies that same artifact again. It publishes the two platform packages before the root package so optional dependencies are available when users install the launcher. It then waits for approval from the protected GitHub `release` environment before accessing registry publishing permissions. Configure required reviewers on that environment to keep this review gate active.

Dispatching the workflow starts verification. It does not itself mean npm or JSR has published. Publication begins only after verification succeeds and the `release` environment approves the publish job. The workflow publishes the tested npm archive and JSR sources in sequence, verifies both registry versions, then creates or completes the GitHub release. That final step creates the version's tag through the GitHub API; tags do not trigger this workflow.

## Publishing setup

Builds, packaging, install checks, and scripts use Node.js 24 and pnpm. npm publishing runs `npm@12.2.0` through `pnpm dlx` for trusted publishing and provenance support. Deno publishes JSR sources.

Configure the protected `release/0.1` branch, required reviewers for the GitHub `release` environment, npm trusted publishing for `@compootor/stooart`, and JSR's GitHub connection. npm may need `NPM_TOKEN` in the `release` environment for its first publication. The token is optional. After npm trust is configured and verified, remove it. Never put tokens in repository files or command-line arguments.

The workflow's use of `id-token: write` permits npm and JSR trusted publishing. This repository change does not configure GitHub environments or registry trust, and local validation does not prove hosted publishing behavior.

## Resume a partial release

Rerun **Publish** from `release/0.1` with version `0.1.1`. The workflow reuses the earliest successful push or manual CI run for the exact commit and verifies the candidate again. It stops if that original artifact is missing, expired, or invalid. Do not rebuild the same commit as a substitute, since that does not prove the archive bytes match.

If npm already has the version, its integrity must match the candidate archive. If JSR already has the version, each published file checksum must match the source manifest, and the version cannot be yanked. A matching registry version is retained while the workflow publishes to the other registry. It verifies both registries before creating or finishing the GitHub release. An existing tag for that version must point to the candidate's source commit, and every release asset is downloaded and compared byte-for-byte before the release is published.

Actions are pinned to verified commits. Dependabot proposes grouped weekly action updates; run normal PR checks before merging them.
