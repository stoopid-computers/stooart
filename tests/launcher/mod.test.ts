import { test, expect } from "vite-plus/test";
import { launch, LaunchError } from "../../launcher/mod.ts";
import { chmod, join, mkdtemp, readdir, rm, writeFile } from "../platform.ts";

test("launch passes literal arguments and returns the child exit status", async () => {
  const dir = await mkdtemp("stooart-launcher-");
  const executable = join(dir, "fixture");

  try {
    await writeFile(
      executable,
      '#!/bin/sh\ntest "$1" = route || exit 21\ntest "$2" = \'--label=two words;$(touch should-not-exist)\' || exit 22\ntest "$3" = \'quoted "value"\' || exit 23\nexit 7\n',
    );
    await chmod(executable, 0o755);

    const result = await launch({
      executable,
      cwd: dir,
      args: ["route", "--label=two words;$(touch should-not-exist)", 'quoted "value"'],
    });

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(await readdir(dir)).not.toContain("should-not-exist");
  } finally {
    await rm(dir);
  }
});

test("launch explains a missing executable", async () => {
  const error = await launch({ executable: "/definitely/not/stooart" }).catch(
    (cause: unknown) => cause,
  );

  expect(error).toBeInstanceOf(LaunchError);
  expect(error).toMatchObject({
    executable: "/definitely/not/stooart",
    message: "stooart executable not found: /definitely/not/stooart",
  });
});

test("launch retains a signal-derived exit status", async () => {
  const dir = await mkdtemp("stooart-launcher-");
  const executable = join(dir, "fixture");

  try {
    await writeFile(executable, "#!/bin/sh\nkill -TERM $$\n");
    await chmod(executable, 0o755);
    const result = await launch({ executable });
    expect(result.exitCode).toBe(143);
    expect(result.signal).toBe("SIGTERM");
  } finally {
    await rm(dir);
  }
});

test("launch merges environment overrides and removes undefined values", async () => {
  const dir = await mkdtemp("stooart-launcher-");
  const executable = join(dir, "fixture");
  const inheritedName = "STOOART_LAUNCHER_INHERITED_TEST";
  const removedName = "STOOART_LAUNCHER_REMOVED_TEST";
  const previousInherited = process.env[inheritedName];
  const previousRemoved = process.env[removedName];

  try {
    process.env[inheritedName] = "inherited";
    process.env[removedName] = "remove-me";
    await writeFile(
      executable,
      '#!/bin/sh\ntest "$STOOART_LAUNCHER_INHERITED_TEST" = inherited || exit 31\ntest -z "${STOOART_LAUNCHER_REMOVED_TEST+x}" || exit 32\ntest "$STOOART_LAUNCHER_OVERRIDE_TEST" = overridden || exit 33\nexit 0\n',
    );
    await chmod(executable, 0o755);

    expect(
      await launch({
        executable,
        env: { [removedName]: undefined, STOOART_LAUNCHER_OVERRIDE_TEST: "overridden" },
      }),
    ).toMatchObject({ exitCode: 0, signal: null });
  } finally {
    if (previousInherited === undefined) delete process.env[inheritedName];
    else process.env[inheritedName] = previousInherited;

    if (previousRemoved === undefined) delete process.env[removedName];
    else process.env[removedName] = previousRemoved;
    await rm(dir);
  }
});
