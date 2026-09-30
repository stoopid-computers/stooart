import { Effect, FileSystem, Path, Schema } from "effect";
import { ScriptError, attempt, check, runPiped, runScript, sha256 } from "./script-effect.ts";

const ArchiveManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optional(Schema.Boolean),
  os: Schema.optional(Schema.Array(Schema.String)),
  cpu: Schema.optional(Schema.Array(Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const RouteResult = Schema.Struct({ workerId: Schema.String, executor: Schema.String });

runScript(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [archive, platformArchive] = process.argv.slice(2);

    if (!archive)
      return yield* new ScriptError({
        message:
          "usage: node --experimental-strip-types scripts/verify-package.ts <root-archive.tgz> <platform-archive.tgz>",
      });
    const archivePath = path.resolve(archive);
    const expectedDigest = process.env.STOOART_EXPECTED_SHA256;
    const bytes = yield* attempt("Could not read package archive", fs.readFile(archivePath));
    const digest = yield* sha256(bytes);

    if (expectedDigest)
      yield* check(
        digest === expectedDigest,
        `archive checksum mismatch: expected ${expectedDigest}, got ${digest}`,
      );

    yield* Effect.acquireUseRelease(
      attempt(
        "Could not create verification directory",
        fs.makeTempDirectory({ prefix: "stooart-verify-" }),
      ),
      (temp) =>
        Effect.gen(function* () {
          const run = (command: ReadonlyArray<string>, cwd = temp) =>
            Effect.gen(function* () {
              const output = yield* runPiped(command, cwd, `Could not run ${command[0]}`);
              yield* check(
                output.exitCode === 0,
                `${command[0]} failed (${output.exitCode}): ${output.stderr || output.stdout}`,
              );

              return output;
            });

          const listing = (yield* run(["tar", "-tzf", archivePath])).stdout
            .trim()
            .split("\n")
            .filter(Boolean);

          const allowed =
            /^(package\/(?:package\.json|launcher\.js|README\.md|LICENSE|THIRD_PARTY_NOTICES|docs\/(?:learning|releasing)\.md|docs\/assets\/(?:routing-boundary|evidence-loop)\.svg|examples\/(?:jev-setup|learning-task|outcome|task)\.json|skills\/(?:delegate\/SKILL\.md|delegate\/references\/request\.json|learn\/SKILL\.md)))$/;

          yield* check(
            Boolean(listing.length) && !listing.some((file) => !allowed.test(file)),
            "archive contains files outside the release allowlist",
          );

          for (const asset of ["routing-boundary.svg", "evidence-loop.svg"])
            yield* check(
              listing.includes(`package/docs/assets/${asset}`),
              `archive missing README diagram: ${asset}`,
            );

          for (const doc of ["learning.md", "releasing.md"])
            yield* check(
              listing.includes(`package/docs/${doc}`),
              `archive missing documentation: ${doc}`,
            );

          for (const example of [
            "jev-setup.json",
            "learning-task.json",
            "outcome.json",
            "task.json",
          ])
            yield* check(
              listing.includes(`package/examples/${example}`),
              `archive missing example: ${example}`,
            );

          for (const skill of [
            "delegate/SKILL.md",
            "delegate/references/request.json",
            "learn/SKILL.md",
          ])
            yield* check(
              listing.includes(`package/skills/${skill}`),
              `archive missing skill: ${skill}`,
            );

          const manifestLine = (yield* run(["tar", "-xOf", archivePath, "package/package.json"]))
            .stdout;

          const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(ArchiveManifest))(
            manifestLine,
          ).pipe(
            Effect.mapError(
              (cause) => new ScriptError({ message: "Invalid archive manifest", cause }),
            ),
          );

          yield* check(Boolean(manifest.version), "archive manifest has no version");
          const local = manifest.private === true;
          yield* check(manifest.name === "@compootor/stooart", "archive is not the root package");
          yield* check(
            !listing.some((file) => file.startsWith("package/bin/")),
            "root archive contains a native executable",
          );
          const target = `${process.platform}-${process.arch}`;
          const nativePackage = `@compootor/stooart-${target}`;
          yield* check(
            manifest.optionalDependencies?.[nativePackage] === manifest.version,
            `root package does not select ${nativePackage}`,
          );
          yield* check(
            Boolean(platformArchive),
            "a matching platform archive is required for install verification",
          );

          const platformPath = path.resolve(platformArchive);

          const platformListing = (yield* run(["tar", "-tzf", platformPath])).stdout
            .trim()
            .split("\n")
            .filter(Boolean);

          yield* check(
            platformListing.length === 4 &&
              platformListing.includes("package/package.json") &&
              platformListing.includes("package/LICENSE") &&
              platformListing.includes("package/THIRD_PARTY_NOTICES") &&
              platformListing.includes("package/bin/stooart"),
            "platform archive must contain its manifest, executable, and license notices",
          );

          const platformManifestLine = (yield* run([
            "tar",
            "-xOf",
            platformPath,
            "package/package.json",
          ])).stdout;

          const platformManifest = yield* Schema.decodeEffect(
            Schema.fromJsonString(ArchiveManifest),
          )(platformManifestLine).pipe(
            Effect.mapError(
              (cause) => new ScriptError({ message: "Invalid platform archive manifest", cause }),
            ),
          );

          yield* check(
            platformManifest.name === nativePackage &&
              platformManifest.version === manifest.version &&
              platformManifest.private === local,
            "platform archive name or version does not match root package",
          );

          yield* check(
            Boolean(
              platformManifest.os?.includes(process.platform) &&
              platformManifest.cpu?.includes(process.arch),
            ),
            "platform archive does not match this host",
          );

          if (!local)
            yield* check(
              !listing.some((file) => file.includes(".ts") || file.includes(".map")),
              "publish archive contains source or map files",
            );

          if (local)
            yield* check(
              Boolean(
                manifest.os?.includes(process.platform) && manifest.cpu?.includes(process.arch),
              ),
              "local archive is not host restricted",
            );
          yield* attempt(
            "Could not initialize npm installation",
            fs.writeFileString(path.join(temp, "package.json"), '{"private":true}\n'),
          );
          yield* run([
            "npm",
            "add",
            "--no-save",
            "--ignore-scripts",
            "--cache",
            path.join(temp, "npm-cache"),
            archivePath,
            platformPath,
          ]);
          const executable = path.join(temp, "node_modules", ".bin", "stooart");
          const version = (yield* run([executable, "--version"])).stdout.trim();
          yield* check(
            version === manifest.version,
            `packaged --version returned ${version}, expected ${manifest.version}`,
          );
          const fixture = path.join(path.resolve("."), "examples", "task.json");
          const routeOutput = (yield* run([executable, "route", fixture])).stdout;

          const route = yield* Schema.decodeEffect(Schema.fromJsonString(RouteResult))(
            routeOutput,
          ).pipe(
            Effect.mapError(
              (cause) => new ScriptError({ message: "Invalid packaged route", cause }),
            ),
          );

          yield* check(
            route.workerId === "configured-worker" && route.executor === "agent-runner",
            "packaged route fixture returned an unexpected worker",
          );
          console.log(`verified ${archivePath}`);
        }),
      (temp) =>
        attempt(
          "Could not remove verification directory",
          fs.remove(temp, { recursive: true, force: true }),
        ),
    );
  }),
);
