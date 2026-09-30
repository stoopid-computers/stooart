import { Effect, Fiber, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { checkError, type CheckError } from "./errors.ts";

export interface CheckResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly failedToExecute: boolean;
}

export function runCheck(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Effect.Effect<CheckResult, CheckError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, { cwd, shell: false, stdin: "ignore" }),
        );

        const stdout = yield* Effect.forkChild(Stream.mkString(Stream.decodeText(handle.stdout)));
        const stderr = yield* Effect.forkChild(Stream.mkString(Stream.decodeText(handle.stderr)));
        const status = yield* handle.exitCode.pipe(Effect.timeoutOption(timeoutMs));

        if (Option.isNone(status)) yield* handle.kill({ killSignal: "SIGKILL" });

        return {
          stdout: yield* Fiber.join(stdout),
          stderr: yield* Fiber.join(stderr),
          status: Option.isSome(status) ? status.value : null,
          failedToExecute: Option.isNone(status),
        };
      }),
    ).pipe(
      Effect.mapError((cause) =>
        checkError("check.spawn", "unable to execute verification command", cause),
      ),
    );
  });
}
