import { Effect, FileSystem, Path, Schema } from "effect";
import { ScriptError, attempt, check, runScript, sha256 } from "./script-effect.ts";

const ReleaseMetadata = Schema.Struct({
  version: Schema.String,
  sourceSha: Schema.String,
  local: Schema.Boolean,
  targets: Schema.Array(Schema.String),
  tarballs: Schema.Array(Schema.Struct({ file: Schema.String, sha256: Schema.String })),
});

runScript(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [metadataPath, checksumsPath] = process.argv.slice(2);

    if (!metadataPath || !checksumsPath)
      return yield* new ScriptError({
        message:
          "usage: node --experimental-strip-types scripts/verify-release.ts <metadata.json> <SHA256SUMS>",
      });

    const metadataText = yield* attempt(
      "Could not read release metadata",
      fs.readFileString(metadataPath),
    );

    const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(ReleaseMetadata))(
      metadataText,
    ).pipe(
      Effect.mapError((cause) => new ScriptError({ message: "Invalid release metadata", cause })),
    );

    const expectedVersion = process.env.STOOART_EXPECTED_VERSION;
    const expectedSourceSha = process.env.STOOART_EXPECTED_SOURCE_SHA;
    const targets = ["darwin-arm64", "linux-x64"];
    yield* check(!metadata.local, "local archives cannot be released");
    yield* check(
      Boolean(
        metadata.version &&
        metadata.sourceSha &&
        metadata.tarballs.length === metadata.targets.length + 1 &&
        metadata.tarballs.every((item) => item.file && item.sha256),
      ),
      "release metadata is incomplete",
    );

    if (expectedVersion)
      yield* check(metadata.version === expectedVersion, `version mismatch: ${metadata.version}`);

    if (expectedSourceSha)
      yield* check(
        metadata.sourceSha === expectedSourceSha,
        `source SHA mismatch: ${metadata.sourceSha}`,
      );
    yield* check(
      metadata.targets.join(",") === targets.join(","),
      "release does not contain both required native targets",
    );
    yield* check(
      metadata.tarballs.every((item) => path.basename(item.file) === item.file),
      "archive names must be relative",
    );

    const expectedArchives = [
      `compootor-stooart-${metadata.version}.tgz`,
      ...targets.map((target) => `compootor-stooart-${target}-${metadata.version}.tgz`),
    ];

    const actualArchives = metadata.tarballs.map((item) => item.file);
    yield* check(
      new Set(actualArchives).size === actualArchives.length &&
        expectedArchives.every((archive) => actualArchives.includes(archive)),
      "release must contain the root npm package and one package for each supported platform",
    );

    const releaseDir = path.dirname(checksumsPath);

    const expectedFiles = new Set(metadata.tarballs.map((item) => item.file));

    const checksumsText = yield* attempt(
      "Could not read release checksums",
      fs.readFileString(checksumsPath),
    );

    const lines = checksumsText.trim().split("\n").filter(Boolean);
    yield* check(lines.length === expectedFiles.size, "checksum coverage is incomplete");

    for (const line of lines) {
      const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);

      if (!match) return yield* new ScriptError({ message: `invalid checksum line: ${line}` });
      const [, digest, file] = match;
      yield* check(
        expectedFiles.delete(file) && !path.isAbsolute(file) && path.normalize(file) === file,
        `unsafe or unexpected checksum path: ${file}`,
      );

      const actual = yield* Effect.flatMap(
        attempt(`Could not read ${file}`, fs.readFile(path.join(releaseDir, file))),
        sha256,
      );

      yield* check(actual === digest, `checksum mismatch for ${file}`);

      const archive = metadata.tarballs.find((item) => item.file === file);

      if (archive)
        yield* check(actual === archive.sha256, `archive metadata checksum mismatch for ${file}`);
    }

    yield* check(expectedFiles.size === 0, `missing checksums: ${[...expectedFiles].join(", ")}`);
    console.log(`verified release ${metadata.version}`);
  }),
);
