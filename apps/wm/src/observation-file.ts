import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decodeObservationDocument,
  emptyObservationDocument,
  ObservationStoreError,
  type ObservationDocument,
  type ObservationSnapshot,
  type ObservationStore,
} from "@paneform/layout";
import { Effect, Stream } from "effect";

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const DEBOUNCE_MS = 100;
const MISSING_REVISION = "missing";
const orphanedLockTokens = new Map<string, string>();

const digest = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

const asStoreError = (error: unknown): ObservationStoreError =>
  error instanceof ObservationStoreError
    ? error
    : error instanceof SyntaxError
    ? new ObservationStoreError("invalid", String(error))
    : new ObservationStoreError("io", String(error));

const ensurePrivateDirectory = (directory: string): void => {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ObservationStoreError("invalid", "observation directory must be a real directory");
  }
  if (process.getuid !== undefined && stat.uid !== process.getuid()) {
    throw new ObservationStoreError("invalid", "observation directory has the wrong owner");
  }
  if (existed && (stat.mode & 0o077) !== 0) {
    throw new ObservationStoreError("invalid", "observation directory permissions must be private");
  }
};

const readSnapshot = (file: string): ObservationSnapshot => {
  try {
    const pathStat = fs.lstatSync(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new ObservationStoreError("invalid", "observation store must be a regular file");
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) {
        throw new ObservationStoreError("invalid", "observation store is not a bounded regular file");
      }
      if (process.getuid !== undefined && stat.uid !== process.getuid()) {
        throw new ObservationStoreError("invalid", "observation store has the wrong owner");
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new ObservationStoreError("invalid", "observation store permissions must be private");
      }
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_STORE_BYTES) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
        if (read === 0) break;
        offset += read;
      }
      if (offset > MAX_STORE_BYTES) {
        throw new ObservationStoreError("invalid", "observation store exceeds size limit");
      }
      data = buffer.subarray(0, offset);
    } finally {
      fs.closeSync(descriptor);
    }
    const document = decodeObservationDocument(JSON.parse(data.toString("utf8")));
    return { revision: digest(data), document };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { revision: MISSING_REVISION, document: emptyObservationDocument() };
    }
    throw asStoreError(error);
  }
};

const quarantineInvalidFile = (file: string): void => {
  try {
    const directory = path.dirname(file);
    const prefix = `${path.basename(file)}.corrupt-`;
    const previous = fs.readdirSync(directory)
      .filter((entry) => entry.startsWith(prefix))
      .sort();
    for (const entry of previous.slice(0, Math.max(0, previous.length - 2))) {
      fs.unlinkSync(path.join(directory, entry));
    }
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const writeAtomically = (
  file: string,
  expectedRevision: string,
  document: ObservationDocument,
): ObservationSnapshot => {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  const data = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (data.byteLength > MAX_STORE_BYTES) {
    throw new ObservationStoreError("invalid", "observation store exceeds size limit");
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let cleanupError: unknown;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const current = readSnapshot(file);
    if (current.revision !== expectedRevision) {
      throw new ObservationStoreError(
        "conflict",
        `observation revision changed from ${expectedRevision} to ${current.revision}`,
      );
    }
    fs.renameSync(temporary, file);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
  return { revision: digest(data), document };
};

const withWriteLock = <A>(file: string, operation: () => A): A => {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  const lock = `${file}.lock`;
  const acquire = (): { descriptor: number; token: string; ownerFile: string; identity: fs.Stats } => {
    const token = randomUUID();
    const ownerFile = `${lock}.owner-${token}`;
    let ownerDescriptor: number | undefined;
    let lockDescriptor: number | undefined;
    let published = false;
    try {
      ownerDescriptor = fs.openSync(ownerFile, "wx", 0o600);
      fs.writeFileSync(ownerDescriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
      fs.fsyncSync(ownerDescriptor);
      fs.closeSync(ownerDescriptor);
      ownerDescriptor = undefined;
      fs.linkSync(ownerFile, lock);
      published = true;
      lockDescriptor = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const identity = fs.fstatSync(lockDescriptor);
      const descriptor = lockDescriptor;
      lockDescriptor = undefined;
      return { descriptor, token, ownerFile, identity };
    } catch (error) {
      if (ownerDescriptor !== undefined) fs.closeSync(ownerDescriptor);
      if (lockDescriptor !== undefined) fs.closeSync(lockDescriptor);
      if (published) {
        try {
          const ownerIdentity = fs.lstatSync(ownerFile);
          const lockIdentity = fs.lstatSync(lock);
          if (ownerIdentity.dev === lockIdentity.dev && ownerIdentity.ino === lockIdentity.ino) {
            fs.unlinkSync(lock);
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
      }
      try {
        fs.unlinkSync(ownerFile);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: unknown };
        if (typeof owner.token === "string" && orphanedLockTokens.get(lock) === owner.token) {
          fs.unlinkSync(lock);
          orphanedLockTokens.delete(lock);
          return acquire();
        }
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") return acquire();
      }
      throw new ObservationStoreError(
        "busy",
        `observation store lock is held; remove ${lock} only after confirming its owner is gone`,
      );
    }
  };
  const { descriptor, token, ownerFile, identity } = acquire();
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = fs.lstatSync(lock);
      if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lock);
      orphanedLockTokens.delete(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        orphanedLockTokens.set(lock, token);
        console.error(`[wm-observations] lock cleanup failed: ${String(error)}`);
      }
    }
    try {
      fs.unlinkSync(ownerFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[wm-observations] owner cleanup failed: ${String(error)}`);
      }
    }
  }
};

export function resolveObservationPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["WM_OBSERVATIONS"];
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) throw new Error("WM_OBSERVATIONS must be an absolute path");
    return configured;
  }
  const home = env["HOME"] ?? os.homedir();
  const state = env["XDG_STATE_HOME"] ?? `${home}/.local/state`;
  if (!path.isAbsolute(state)) throw new Error("observation state directory must be absolute");
  return `${state}/wm/observations.json`;
}

export function createFileObservationStore(file: string): ObservationStore {
  const load = (): Effect.Effect<ObservationSnapshot, ObservationStoreError> =>
    Effect.try({
      try: () => readSnapshot(file),
      catch: asStoreError,
    }).pipe(
      Effect.catchIf(
        (error) => error.code === "invalid",
        () => Effect.try({
          try: () => {
            quarantineInvalidFile(file);
            return { revision: MISSING_REVISION, document: emptyObservationDocument() };
          },
          catch: asStoreError,
        }),
      ),
    );

  return {
    load,
    save: (expectedRevision, input) =>
      Effect.try({
        try: () => {
          const document = decodeObservationDocument(input);
          try {
            return withWriteLock(file, () => {
              const current = readSnapshot(file);
              if (current.revision !== expectedRevision) {
                throw new ObservationStoreError(
                  "conflict",
                  `observation revision changed from ${expectedRevision} to ${current.revision}`,
                );
              }
              return writeAtomically(file, expectedRevision, document);
            });
          } catch (error) {
            let current: ObservationSnapshot | undefined;
            try {
              current = readSnapshot(file);
            } catch {
              // Preserve the original failure when commit state cannot be established.
            }
            if (current !== undefined && JSON.stringify(current.document) === JSON.stringify(document)) {
              const storeError = asStoreError(error);
              if (storeError.code === "io") {
                throw new ObservationStoreError(
                  "durability",
                  `observation document committed but durability is uncertain: ${storeError.message}`,
                  current,
                );
              }
              return current;
            }
            throw error;
          }
        },
        catch: asStoreError,
      }),
    changes: (afterRevision) =>
      Stream.asyncPush<ObservationSnapshot, ObservationStoreError>((emit) =>
        Effect.acquireRelease(
          Effect.try({
            try: () => {
            const directory = path.dirname(file);
            ensurePrivateDirectory(directory);
            let lastRevision = afterRevision;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const refresh = () => {
              timer = undefined;
              try {
                const snapshot = readSnapshot(file);
                if (snapshot.revision === lastRevision) return;
                lastRevision = snapshot.revision;
                emit.single(snapshot);
              } catch (error) {
                const storeError = asStoreError(error);
                if (storeError.code === "invalid") {
                  console.error(`[wm-observations] ignored invalid live update: ${storeError.message}`);
                } else {
                  emit.fail(storeError);
                }
              }
            };
            const watcher = fs.watch(directory, (_event, changed) => {
              if (changed !== null && String(changed) !== path.basename(file)) return;
              if (timer !== undefined) clearTimeout(timer);
              timer = setTimeout(refresh, DEBOUNCE_MS);
            });
            watcher.on("error", (error) => {
              emit.fail(asStoreError(error));
            });
            refresh();
            return { watcher, clear: () => timer !== undefined && clearTimeout(timer) };
            },
            catch: asStoreError,
          }),
          ({ watcher, clear }) => Effect.sync(() => {
            clear();
            watcher.close();
          }),
        ),
      ),
  };
}
