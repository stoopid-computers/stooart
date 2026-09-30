import { Effect, FileSystem, Path, Schema } from "effect";
import { VERSION } from "../src/version.ts";
import {
  ScriptError,
  attempt,
  check,
  runInherited,
  runPiped,
  runScript,
  sha256,
} from "./script-effect.ts";

const PackageIdentity = Schema.Struct({ name: Schema.String, version: Schema.String });

runScript(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dir, "..");
    const target = `${process.platform}-${process.arch}`;

    const manifestText = yield* attempt(
      "Could not read package identity",
      fs.readFileString(path.join(root, "package.json")),
    );

    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(PackageIdentity))(
      manifestText,
    ).pipe(
      Effect.mapError((cause) => new ScriptError({ message: "Invalid package identity", cause })),
    );

    const jsrText = yield* attempt(
      "Could not read JSR identity",
      fs.readFileString(path.join(root, "jsr.json")),
    );

    const jsr = yield* Schema.decodeEffect(Schema.fromJsonString(PackageIdentity))(jsrText).pipe(
      Effect.mapError((cause) => new ScriptError({ message: "Invalid JSR identity", cause })),
    );

    yield* check(
      manifest.version === VERSION && jsr.version === VERSION && manifest.name === jsr.name,
      "package.json, jsr.json, and src/version.ts must agree before building",
    );
    yield* check(
      target === "darwin-arm64" || target === "linux-x64",
      `Unsupported release target: ${target}`,
    );

    const dist = path.join(root, "dist");
    const binary = path.join(dist, `stooart-${target}`);
    yield* attempt("Could not create dist directory", fs.makeDirectory(dist, { recursive: true }));

    const buildExit = yield* runInherited(
      [
        "bun",
        "build",
        "--compile",
        "--target",
        `bun-${target}`,
        "--outfile",
        binary,
        "src/cli.ts",
        "--minify",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--no-compile-autoload-package-json",
      ],
      root,
      "Could not run Bun compile",
    );

    yield* check(buildExit === 0, `Native compilation failed (${buildExit})`);

    const binaryBytes = yield* attempt("Could not read native artifact", fs.readFile(binary));
    const privatePaths = [root, process.env.HOME ?? process.env.USERPROFILE ?? ""];

    for (const privatePath of privatePaths) {
      if (privatePath && privatePath !== "/") {
        const needle = new TextEncoder().encode(privatePath);

        let found = false;
        let index = binaryBytes.indexOf(needle[0]);

        while (index !== -1 && index + needle.length <= binaryBytes.length) {
          let offset = 1;

          while (offset < needle.length && binaryBytes[index + offset] === needle[offset]) offset++;

          if (offset === needle.length) {
            found = true;
            break;
          }

          index = binaryBytes.indexOf(needle[0], index + 1);
        }

        if (found) {
          yield* attempt(
            "Could not discard unsafe native artifact",
            fs.remove(binary, { force: true }),
          );
          yield* attempt(
            "Could not discard unsafe provenance",
            fs.remove(`${binary}.build.json`, { force: true }),
          );
          yield* check(false, "Native artifact contains a machine-specific path");
        }
      }
    }

    const commit = yield* runPiped(
      ["git", "rev-parse", "--verify", "HEAD"],
      root,
      "Could not inspect Git HEAD",
    );

    const status = yield* runPiped(
      ["git", "status", "--porcelain"],
      root,
      "Could not inspect Git status",
    );

    yield* attempt(
      "Could not write native provenance",
      fs.writeFileString(
        `${binary}.build.json`,
        `${JSON.stringify(
          {
            target,
            version: VERSION,
            sourceSha: commit.exitCode === 0 ? commit.stdout.trim() : null,
            dirty: status.exitCode !== 0 || status.stdout.trim() !== "",
            sha256: yield* sha256(binaryBytes),
          },
          null,
          2,
        )}\n`,
      ),
    );
  }),
);
