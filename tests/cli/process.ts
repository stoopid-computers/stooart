import { BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { join } from "../platform.ts";

const executable = Bun.env.STOOART_TEST_BINARY;

const prefix = executable ? [executable] : [Bun.argv[0], join(import.meta.dir, "../../src/cli.ts")];

export const run = (
  args: readonly string[],
  input: Schema.Json = "",
  env: Record<string, string> = {},
  unsetEnv: readonly ("TYPESAFE_API_KEY" | "TYPESAFE_BASE_URL")[] = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const childEnv = {
        ...process.env,
        TYPESAFE_API_KEY: "",
        TYPESAFE_BASE_URL: "",
        ...env,
      } satisfies Record<string, string | undefined>;

      for (const key of unsetEnv) delete childEnv[key];

      const child = yield* spawner.spawn(
        ChildProcess.make(prefix[0], [...prefix.slice(1), ...args], {
          stdin: Stream.make(
            new TextEncoder().encode(
              Schema.is(Schema.String)(input) ? input : JSON.stringify(input),
            ),
          ),
          stdout: "pipe",
          stderr: "pipe",
          env: childEnv,
          extendEnv: false,
        }),
      );

      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      return { stdout, stderr, code: Number(code) };
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
