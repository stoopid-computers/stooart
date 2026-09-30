import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";

const fs = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));

const path = Effect.runSync(Effect.provide(Path.Path, NodePath.layer));

export const join = path.join;

export const mkdtemp = (prefix: string) => Effect.runPromise(fs.makeTempDirectory({ prefix }));

export const mkdir = (file: string) => Effect.runPromise(fs.makeDirectory(file));

export const readFile = (file: string) => Effect.runPromise(fs.readFileString(file));

export const writeFile = (file: string, content: string) =>
  Effect.runPromise(fs.writeFileString(file, content));

export const rm = (file: string) =>
  Effect.runPromise(fs.remove(file, { recursive: true, force: true }));

export const stat = (file: string) => Effect.runPromise(fs.stat(file));

export const symlink = (target: string, link: string) =>
  Effect.runPromise(fs.symlink(target, link));

export const chmod = (file: string, mode: number) => Effect.runPromise(fs.chmod(file, mode));

export const readdir = (file: string) => Effect.runPromise(fs.readDirectory(file));
