import { Effect, Path } from "effect";
import { check, runInherited, runScript } from "./script-effect.ts";

runScript(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url));
    const root = path.resolve(path.dirname(scriptPath), "..");
    const binary = path.join(root, "dist", `stooart-${process.platform}-${process.arch}`);

    const exitCode = yield* runInherited(
      ["pnpm", "exec", "vp", "test", "tests/cli"],
      root,
      "Could not run native smoke tests",
      { ...process.env, STOOART_TEST_BINARY: binary },
    );

    yield* check(exitCode === 0, `Native smoke tests failed (${exitCode})`);
  }),
);
