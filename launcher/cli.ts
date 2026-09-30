#!/usr/bin/env node
import { NodeServices } from "@effect/platform-node";
import { Console, Data, Effect, FileSystem, Path } from "effect";
import { launchEffect } from "./mod.ts";

const supportedTargets = new Set(["darwin-arm64", "linux-x64"]);

export class PackageError extends Data.TaggedError("PackageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const packagedExecutable = (platform = process.platform, arch = process.arch) =>
  Effect.gen(function* () {
    const target = `${platform}-${arch}`;
    const path = yield* Path.Path;

    if (!supportedTargets.has(target))
      return yield* new PackageError({ message: `stooart has no packaged binary for ${target}` });

    return yield* path
      .fromFileUrl(new URL(import.meta.resolve(`@compootor/stooart-${target}/bin/stooart`)))
      .pipe(
        Effect.mapError(
          (cause) =>
            new PackageError({ message: `Unable to locate stooart binary for ${target}`, cause }),
        ),
      );
  }).pipe(Effect.provide(NodeServices.layer));

export const runPackaged = (args: readonly string[] = process.argv.slice(2)) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const executable = yield* packagedExecutable();
    const exists = yield* fs.exists(executable);

    if (!exists)
      return yield* new PackageError({
        message: `stooart package is missing its native binary: ${executable}`,
      });

    return (yield* launchEffect({ executable, args })).exitCode;
  }).pipe(Effect.provide(NodeServices.layer));

if (import.meta.main) {
  await Effect.runPromise(
    runPackaged().pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Console.error(error.message).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 1;
              }),
            ),
          ),
        onSuccess: (code) =>
          Effect.sync(() => {
            process.exitCode = code;
          }),
      }),
    ),
  );
}
