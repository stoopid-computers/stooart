import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Crypto, Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class ScriptError extends Data.TaggedError("ScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function attempt<A, E, R>(message: string, operation: Effect.Effect<A, E, R>) {
  return operation.pipe(Effect.mapError((cause) => new ScriptError({ message, cause })));
}

export function check(condition: boolean, message: string) {
  return condition ? Effect.void : Effect.fail(new ScriptError({ message }));
}

export function runInherited(
  command: ReadonlyArray<string>,
  cwd: string,
  message: string,
  env?: Record<string, string | undefined>,
) {
  const [executable, ...args] = command;

  return attempt(
    message,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      return yield* spawner.exitCode(
        ChildProcess.make(executable, args, {
          cwd,
          env,
          extendEnv: env !== undefined,
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
    }),
  );
}

function decode(chunks: ReadonlyArray<string>) {
  return chunks.join("");
}

export function runPiped(command: ReadonlyArray<string>, cwd: string, message: string) {
  const [executable, ...args] = command;

  return attempt(
    message,
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const child = yield* spawner.spawn(
          ChildProcess.make(executable, args, { cwd, stdout: "pipe", stderr: "pipe" }),
        );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.runCollect(Stream.decodeText(child.stdout)),
            Stream.runCollect(Stream.decodeText(child.stderr)),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        return { stdout: decode(stdout), stderr: decode(stderr), exitCode };
      }),
    ),
  );
}

export function sha256(data: Uint8Array) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;

    const digest = yield* crypto
      .digest("SHA-256", data)
      .pipe(
        Effect.mapError((cause) => new ScriptError({ message: "Could not hash bytes", cause })),
      );

    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

export function runScript<A, E>(program: Effect.Effect<A, E, BunServices.BunServices>) {
  BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
}
