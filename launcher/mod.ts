import { NodeServices } from "@effect/platform-node";
import { Effect, Predicate, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  launchWith,
  LaunchError,
  type LaunchOptions,
  type LaunchResult,
  SpawnFailure,
  type SpawnAdapter,
} from "./lifecycle.ts";

export { LaunchError };

export type { LaunchOptions, LaunchResult };

const signalCodes = {
  SIGINT: 2,
  SIGTERM: 15,
} as const;

const SignalError = Schema.Struct({
  reason: Schema.Struct({ cause: Schema.Struct({ message: Schema.String }) }),
});

const SignalName = Schema.Literals(["SIGINT", "SIGTERM"]);

const nodeAdapter: SpawnAdapter<ChildProcessSpawner.ChildProcessSpawner> = {
  spawn(executable, options) {
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const child = yield* spawner
        .spawn(
          ChildProcess.make(executable, [...(options.args ?? [])], {
            cwd: options.cwd,
            env: options.env,
            extendEnv: true,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        .pipe(Effect.mapError((cause) => new SpawnFailure({ cause })));

      return {
        exited: child.exitCode.pipe(
          Effect.map((exitCode) => ({ exitCode: Number(exitCode), signal: null })),
          Effect.catchTag("PlatformError", (error) => {
            const decoded = Schema.decodeUnknownOption(SignalError)(error);

            if (Predicate.isTagged(decoded, "None"))
              return Effect.fail(new SpawnFailure({ cause: error }));

            const captured = /signal: '(SIGINT|SIGTERM)'/.exec(
              decoded.value.reason.cause.message,
            )?.[1];

            const signal = Schema.decodeUnknownOption(SignalName)(captured);

            if (Predicate.isTagged(signal, "None"))
              return Effect.fail(new SpawnFailure({ cause: error }));

            return Effect.succeed({
              exitCode: 128 + signalCodes[signal.value],
              signal: signal.value,
            });
          }),
          Effect.mapError((cause) => new SpawnFailure({ cause })),
        ),
        kill: (signal) =>
          child
            .kill({ killSignal: signal })
            .pipe(Effect.mapError((cause) => new SpawnFailure({ cause }))),
      };
    });
  },
  addSignalListener: (signal, listener) => process.on(signal, listener),
  removeSignalListener: (signal, listener) => process.off(signal, listener),
};

/** Launch an installed executable with scoped signal forwarding and cancellation. */
export const launchEffect = (
  options: LaunchOptions = {},
): Effect.Effect<LaunchResult, LaunchError> =>
  Effect.provide(launchWith(nodeAdapter, options), NodeServices.layer);

/** Promise adapter for Node consumers. The native executable must be installed separately. */
export const launch = (options: LaunchOptions = {}): Promise<LaunchResult> =>
  Effect.runPromise(launchEffect(options));

export default launch;
