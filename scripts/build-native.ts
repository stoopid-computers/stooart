import { compile, renderDiagnostics } from "@scriptc/compiler";
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

const BuildManifest = Schema.Struct({
  ...PackageIdentity.fields,
  devDependencies: Schema.Struct({ "@scriptc/compiler": Schema.String }),
});

runScript(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url));
    const root = path.resolve(path.dirname(scriptPath), "..");
    const target = `${process.platform}-${process.arch}`;

    const manifestText = yield* attempt(
      "Could not read package identity",
      fs.readFileString(path.join(root, "package.json")),
    );

    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(BuildManifest))(
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

    const workspace = yield* attempt(
      "Could not create native build workspace",
      fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "stooart-build-" }),
    );

    const payload = path.join(workspace, "node_modules", "stooart-runtime");
    const entry = path.join(workspace, "entry.ts");
    const executable = path.join(workspace, "stooart");

    const bundleExit = yield* runInherited(
      [
        "pnpm",
        "exec",
        "vp",
        "pack",
        "src/cli.ts",
        "--platform",
        "node",
        "--format",
        "esm",
        "--minify",
        "--out-dir",
        payload,
        "--logLevel",
        "error",
      ],
      root,
      "Could not bundle native application",
    );

    yield* check(bundleExit === 0, "Native application bundling failed");

    // The package boundary lets scriptc embed Effect in its supported dynamic runtime.
    // No application values cross the static/dynamic boundary and no modules load from disk.
    yield* attempt(
      "Could not write native payload manifest",
      fs.writeFileString(
        path.join(payload, "package.json"),
        JSON.stringify({
          name: "stooart-runtime",
          version: VERSION,
          type: "module",
          exports: "./cli.mjs",
        }),
      ),
    );
    yield* attempt(
      "Could not write native entry",
      fs.writeFileString(entry, 'import "stooart-runtime";\n'),
    );

    const compiled = yield* Effect.tryPromise({
      try: () =>
        compile(entry, {
          outPath: executable,
          outDir: path.join(workspace, "c"),
          backend: "c",
          dynamic: true,
          optimization: "release",
          strip: true,
        }),
      catch: (cause) => new ScriptError({ message: "scriptc native compilation failed", cause }),
    });

    if (!compiled.ok)
      return yield* new ScriptError({
        message: renderDiagnostics(compiled.diagnostics, compiled.sourceTexts, { color: false }),
      });

    const version = yield* runPiped(
      [executable, "--version"],
      workspace,
      "Could not run native executable",
    );

    yield* check(
      version.exitCode === 0 && version.stdout.trim() === VERSION,
      "Native executable version check failed",
    );

    const binaryBytes = yield* attempt("Could not read native artifact", fs.readFile(executable));
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
          const suffix = new TextDecoder()
            .decode(binaryBytes.subarray(index + needle.length, index + needle.length + 240))
            .split("\0")[0];

          yield* check(
            false,
            `Native artifact contains a machine-specific path: <build-root>${suffix}`,
          );
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
      "Could not invalidate previous provenance",
      fs.remove(`${binary}.build.json`, { force: true }),
    );
    yield* attempt("Could not install native artifact", fs.copyFile(executable, binary));
    yield* attempt("Could not mark native artifact executable", fs.chmod(binary, 0o755));

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
            compiler: {
              name: "scriptc",
              version: manifest.devDependencies["@scriptc/compiler"],
              backend: compiled.backend,
              dynamic: true,
            },
            bytes: binaryBytes.length,
          },
          null,
          2,
        )}\n`,
      ),
    );
  }).pipe(Effect.scoped),
);
