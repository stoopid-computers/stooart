import { Effect } from "effect";
import {
  launchWith,
  LaunchError,
  type LaunchOptions,
  type LaunchResult,
  type SpawnAdapter,
} from "./lifecycle.ts";

export { LaunchError };

export type { LaunchOptions, LaunchResult };

const bunAdapter: SpawnAdapter = {
  spawn(executable, options) {
    const child = Bun.spawn([executable, ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...Bun.env, ...options.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    return {
      exited: child.exited.then((exitCode) => ({ exitCode, signal: child.signalCode })),
      kill: (signal) => child.kill(signal),
    };
  },
  addSignalListener: (signal, listener) => process.on(signal, listener),
  removeSignalListener: (signal, listener) => process.off(signal, listener),
};

/** Launch an installed executable with scoped signal forwarding and cancellation. */
export const launchEffect = (
  options: LaunchOptions = {},
): Effect.Effect<LaunchResult, LaunchError> => launchWith(bunAdapter, options);

/** Promise adapter for Bun consumers. The native executable must be installed separately. */
export const launch = (options: LaunchOptions = {}): Promise<LaunchResult> =>
  Effect.runPromise(launchEffect(options));

export default launch;
