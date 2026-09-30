import { Effect, FileSystem, Path } from "effect";
import { cliError, learningError, type LearningError } from "./errors.ts";

const failure = (detail: string, path?: string, cause?: unknown) =>
  learningError("jev.credentials", detail, path, cause);

export const credentialPath: Effect.Effect<string, LearningError, Path.Path> = Effect.gen(
  function* () {
    const paths = yield* Path.Path;
    const home = Bun.env.HOME;
    const configHome = Bun.env.XDG_CONFIG_HOME ?? (home ? paths.join(home, ".config") : "");

    if (!configHome || !paths.isAbsolute(configHome))
      return yield* cliError("jev.credentials", "configuration directory must be an absolute path");

    return paths.join(configHome, "stooart", "credentials");
  },
);

const ensureNoSymlink = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, LearningError> =>
  fs.readLink(path).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true,
    }),
    Effect.flatMap((isSymlink) =>
      isSymlink ? Effect.fail(failure("refusing a symbolic link", path)) : Effect.void,
    ),
  );

const validateCredential = (
  fs: FileSystem.FileSystem,
  file: string,
  directory: string,
): Effect.Effect<boolean, LearningError> =>
  Effect.gen(function* () {
    const exists = yield* fs
      .exists(file)
      .pipe(Effect.mapError((cause) => failure("unable to check saved credential", file, cause)));

    if (!exists) return false;

    yield* ensureNoSymlink(fs, directory);

    const directoryInfo = yield* fs
      .stat(directory)
      .pipe(
        Effect.mapError((cause) =>
          failure("unable to inspect credential directory", directory, cause),
        ),
      );

    if (directoryInfo.type !== "Directory")
      return yield* failure("credential path is not a directory", directory);

    if ((directoryInfo.mode & 0o077) !== 0)
      return yield* failure("credential directory permissions must be 0700", directory);

    yield* ensureNoSymlink(fs, file);

    const info = yield* fs
      .stat(file)
      .pipe(Effect.mapError((cause) => failure("unable to inspect saved credential", file, cause)));

    if (info.type !== "File") return yield* failure("saved credential is not a regular file", file);

    if ((info.mode & 0o077) !== 0)
      return yield* failure("saved credential permissions must be 0600", file);

    return true;
  });

export const saveCredential = (
  key: string,
): Effect.Effect<void, LearningError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const file = yield* credentialPath;
    const directory = paths.dirname(file);

    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError((cause) =>
          failure("unable to prepare credential directory", directory, cause),
        ),
      );
    yield* ensureNoSymlink(fs, directory);

    const directoryInfo = yield* fs
      .stat(directory)
      .pipe(
        Effect.mapError((cause) =>
          failure("unable to inspect credential directory", directory, cause),
        ),
      );

    if (directoryInfo.type !== "Directory")
      return yield* failure("credential path is not a directory", directory);

    yield* fs
      .chmod(directory, 0o700)
      .pipe(
        Effect.mapError((cause) =>
          failure("unable to secure credential directory", directory, cause),
        ),
      );

    yield* validateCredential(fs, file, directory);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs
          .makeTempFileScoped({ directory, prefix: ".credentials-" })
          .pipe(
            Effect.mapError((cause) =>
              failure("unable to prepare credential file", directory, cause),
            ),
          );

        yield* fs
          .chmod(temporary, 0o600)
          .pipe(
            Effect.mapError((cause) =>
              failure("unable to secure credential file", temporary, cause),
            ),
          );
        yield* fs
          .writeFileString(temporary, `${key}\n`)
          .pipe(
            Effect.mapError((cause) =>
              failure("unable to save TypeSafe credential", temporary, cause),
            ),
          );
        yield* fs
          .rename(temporary, file)
          .pipe(
            Effect.mapError((cause) =>
              failure("unable to install TypeSafe credential", file, cause),
            ),
          );
      }),
    );
  });

export const readCredential: Effect.Effect<
  string | undefined,
  LearningError,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* credentialPath;
  const paths = yield* Path.Path;
  const exists = yield* validateCredential(fs, file, paths.dirname(file));

  if (!exists) return undefined;

  const value = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((cause) => failure("unable to read saved credential", file, cause)));

  const key = value.trim();

  return key.length === 0 ? undefined : key;
});

export const removeCredential: Effect.Effect<
  boolean,
  LearningError,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* credentialPath;
  const paths = yield* Path.Path;
  const exists = yield* validateCredential(fs, file, paths.dirname(file));

  if (!exists) return false;

  yield* fs
    .remove(file)
    .pipe(Effect.mapError((cause) => failure("unable to remove saved credential", file, cause)));

  return true;
});
