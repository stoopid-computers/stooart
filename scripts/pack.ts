import { Effect, FileSystem, Path, Schema } from "effect";
import {
  ScriptError,
  attempt,
  check,
  runInherited,
  runPiped,
  runScript,
  sha256,
} from "./script-effect.ts";

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  license: Schema.String,
  repository: Schema.Struct({ type: Schema.String, url: Schema.String }),
  engines: Schema.Struct({ node: Schema.String }),
});

const BuildProvenance = Schema.Struct({
  target: Schema.String,
  version: Schema.String,
  sourceSha: Schema.NullOr(Schema.String),
  dirty: Schema.Boolean,
  sha256: Schema.String,
  compiler: Schema.Struct({
    name: Schema.Literal("scriptc"),
    version: Schema.String,
    backend: Schema.Literal("c"),
    dynamic: Schema.Literal(true),
  }),
});

runScript(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(".");
    const local = process.argv.includes("--local");
    const targets = ["darwin-arm64", "linux-x64"] as const;
    const hostTarget = `${process.platform}-${process.arch}`;

    yield* check(
      targets.some((target) => target === hostTarget),
      `unsupported host target: ${hostTarget}`,
    );

    const selected = local ? [hostTarget] : [...targets];
    const stage = path.join(root, ".stooart-stage");
    const release = path.join(root, ".stooart-release");

    const packageText = yield* attempt(
      "Could not read package manifest",
      fs.readFileString(path.join(root, "package.json")),
    );

    const packageJson = yield* Schema.decodeEffect(Schema.fromJsonString(PackageManifest))(
      packageText,
    ).pipe(
      Effect.mapError((cause) => new ScriptError({ message: "Invalid package manifest", cause })),
    );

    const gitText = (args: ReadonlyArray<string>) =>
      Effect.map(runPiped(["git", ...args], root, `Could not run git ${args[0]}`), (result) =>
        result.exitCode === 0 ? result.stdout.trim() : null,
      );

    const sourceSha = yield* gitText(["rev-parse", "--verify", "HEAD"]);
    const dirty = (yield* gitText(["status", "--porcelain"])) !== "";
    yield* check(
      local || Boolean(sourceSha && !dirty),
      "release pack requires a clean tree with a committed HEAD; use --local for a private host archive",
    );

    yield* attempt(
      "Could not reset package stage",
      fs.remove(stage, { recursive: true, force: true }),
    );
    yield* attempt(
      "Could not reset release directory",
      fs.remove(release, { recursive: true, force: true }),
    );
    yield* attempt(
      "Could not create package bin directory",
      fs.makeDirectory(path.join(stage, "bin"), { recursive: true }),
    );
    yield* attempt(
      "Could not create package asset directory",
      fs.makeDirectory(path.join(stage, "docs", "assets"), { recursive: true }),
    );
    yield* attempt(
      "Could not create package docs directory",
      fs.makeDirectory(path.join(stage, "docs"), { recursive: true }),
    );
    yield* attempt(
      "Could not create package examples directory",
      fs.makeDirectory(path.join(stage, "examples"), { recursive: true }),
    );
    yield* attempt(
      "Could not create package skill directories",
      fs.makeDirectory(path.join(stage, "skills", "delegate", "references"), {
        recursive: true,
      }),
    );
    yield* attempt(
      "Could not create package learn skill directory",
      fs.makeDirectory(path.join(stage, "skills", "learn"), { recursive: true }),
    );
    yield* attempt(
      "Could not create release directory",
      fs.makeDirectory(release, { recursive: true }),
    );

    for (const file of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES"]) {
      yield* attempt(
        `Could not copy required package file ${file}`,
        fs.copyFile(path.join(root, file), path.join(stage, file)),
      );
    }

    for (const file of ["routing-boundary.svg", "evidence-loop.svg"]) {
      yield* attempt(
        `Could not copy required package asset ${file}`,
        fs.copyFile(
          path.join(root, "docs", "assets", file),
          path.join(stage, "docs", "assets", file),
        ),
      );
    }

    for (const file of ["learning.md", "releasing.md"]) {
      yield* attempt(
        `Could not copy package documentation ${file}`,
        fs.copyFile(path.join(root, "docs", file), path.join(stage, "docs", file)),
      );
    }

    for (const file of ["jev-setup.json", "learning-task.json", "outcome.json", "task.json"]) {
      yield* attempt(
        `Could not copy package example ${file}`,
        fs.copyFile(path.join(root, "examples", file), path.join(stage, "examples", file)),
      );
    }

    for (const file of [
      "delegate/SKILL.md",
      "delegate/references/request.json",
      "learn/SKILL.md",
    ]) {
      yield* attempt(
        `Could not copy package skill ${file}`,
        fs.copyFile(path.join(root, "skills", file), path.join(stage, "skills", file)),
      );
    }

    const launcherExit = yield* runInherited(
      [
        "pnpm",
        "exec",
        "vp",
        "pack",
        "launcher/cli.ts",
        "--out-dir",
        stage,
        "--format",
        "esm",
        "--minify",
        "--logLevel",
        "error",
      ],
      root,
      "Could not build npm launcher",
    );

    yield* check(launcherExit === 0, "failed to build npm launcher");
    yield* attempt(
      "Could not rename npm launcher",
      fs.rename(path.join(stage, "cli.mjs"), path.join(stage, "launcher.js")),
    );

    const digest = (file: string) =>
      Effect.flatMap(attempt(`Could not read ${file}`, fs.readFile(file)), sha256);

    for (const target of selected) {
      const name = `stooart-${target}`;
      const source = path.join(root, "dist", name);
      yield* attempt(`missing native binary: ${source}`, fs.stat(source));

      if (!local) {
        const provenancePath = path.join(root, "dist", `${name}.build.json`);

        const provenanceText = yield* attempt(
          `Could not read ${name} provenance`,
          fs.readFileString(provenancePath),
        );

        const provenance = yield* Schema.decodeEffect(Schema.fromJsonString(BuildProvenance))(
          provenanceText,
        ).pipe(
          Effect.mapError(
            (cause) => new ScriptError({ message: `Invalid ${name} provenance`, cause }),
          ),
        );

        yield* check(
          provenance.target === target &&
            provenance.version === packageJson.version &&
            provenance.sourceSha === sourceSha &&
            provenance.dirty === false &&
            provenance.sha256 === (yield* digest(source)),
          `native build provenance does not match ${name}`,
        );
      }

      yield* attempt(`Could not stage ${name}`, fs.copyFile(source, path.join(stage, "bin", name)));
      yield* attempt(
        `Could not mark ${name} executable`,
        fs.chmod(path.join(stage, "bin", name), 0o755),
      );
    }

    const manifestBase = {
      name: packageJson.name,
      version: packageJson.version,
      description: packageJson.description,
      license: packageJson.license,
      type: "module",
      bin: { stooart: "launcher.js" },
      repository: packageJson.repository,
      engines: packageJson.engines,
      optionalDependencies: Object.fromEntries(
        (local ? selected : targets).map((target) => [
          `@compootor/stooart-${target}`,
          packageJson.version,
        ]),
      ),
      files: [
        "launcher.js",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES",
        "docs",
        "examples",
        "skills",
      ],
    };

    const manifest = local
      ? { ...manifestBase, private: true, os: [process.platform], cpu: [process.arch] }
      : manifestBase;

    yield* attempt(
      "Could not write package manifest",
      fs.writeFileString(
        path.join(stage, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
    );

    const archive = path.join(
      release,
      `${packageJson.name.replace(/^@/, "").replace("/", "-")}-${packageJson.version}.tgz`,
    );

    const pack = yield* runPiped(
      ["npm", "pack", "--silent", "--ignore-scripts", "--pack-destination", release],
      stage,
      "Could not create npm archive",
    );

    yield* check(
      pack.exitCode === 0,
      `npm pack failed (${pack.exitCode}): ${pack.stderr || pack.stdout}`,
    );
    yield* attempt("Could not find npm archive", fs.stat(archive));

    const archives = [archive];

    for (const target of selected) {
      const name = `stooart-${target}`;

      const platformStage = yield* attempt(
        `Could not create ${name} workspace`,
        fs.makeTempDirectoryScoped({ prefix: `${name}-stage-` }),
      );

      yield* attempt(
        `Could not create ${name} stage`,
        fs.makeDirectory(path.join(platformStage, "bin"), { recursive: true }),
      );
      yield* attempt(
        `Could not stage ${name} binary`,
        fs.copyFile(path.join(root, "dist", name), path.join(platformStage, "bin", "stooart")),
      );
      yield* attempt(
        `Could not mark ${name} executable`,
        fs.chmod(path.join(platformStage, "bin", "stooart"), 0o755),
      );

      for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES"])
        yield* attempt(
          `Could not stage ${name} ${notice}`,
          fs.copyFile(path.join(root, notice), path.join(platformStage, notice)),
        );

      const platformManifest = {
        name: `@compootor/${name}`,
        version: packageJson.version,
        description: `${packageJson.description} native executable for ${target}`,
        license: packageJson.license,
        repository: packageJson.repository,
        private: local,
        os: [target.startsWith("darwin") ? "darwin" : "linux"],
        cpu: [target.endsWith("arm64") ? "arm64" : "x64"],
        files: ["bin/stooart", "LICENSE", "THIRD_PARTY_NOTICES"],
      };

      yield* attempt(
        `Could not write ${name} manifest`,
        fs.writeFileString(
          path.join(platformStage, "package.json"),
          `${JSON.stringify(platformManifest, null, 2)}\n`,
        ),
      );
      const platformArchive = path.join(release, `compootor-${name}-${packageJson.version}.tgz`);

      const platformPack = yield* runPiped(
        ["npm", "pack", "--silent", "--ignore-scripts", "--pack-destination", release],
        platformStage,
        `Could not create ${name} archive`,
      );

      yield* check(
        platformPack.exitCode === 0,
        `npm pack failed for ${name} (${platformPack.exitCode}): ${platformPack.stderr || platformPack.stdout}`,
      );
      yield* attempt(`Could not find ${name} archive`, fs.stat(platformArchive));
      archives.push(platformArchive);
    }

    const checksumLines: string[] = [];

    for (const packageArchive of archives)
      checksumLines.push(`${yield* digest(packageArchive)}  ${path.basename(packageArchive)}`);
    yield* attempt(
      "Could not write release checksums",
      fs.writeFileString(path.join(release, "SHA256SUMS"), `${checksumLines.join("\n")}\n`),
    );
    const tarballs: { file: string; sha256: string }[] = [];

    for (const packageArchive of archives)
      tarballs.push({ file: path.basename(packageArchive), sha256: yield* digest(packageArchive) });
    yield* attempt(
      "Could not write release metadata",
      fs.writeFileString(
        path.join(release, "release-metadata.json"),
        `${JSON.stringify({ name: packageJson.name, version: packageJson.version, sourceSha, git: { committed: Boolean(sourceSha), dirty }, local, targets: selected, tarballs }, null, 2)}\n`,
      ),
    );
    console.log(archive);
  }).pipe(Effect.scoped),
);
