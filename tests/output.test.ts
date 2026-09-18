import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Cause, Effect, Exit } from "effect";
import { writeResult, writeStream } from "../src/output";

const directory = await mkdtemp(join(tmpdir(), "natter-output-"));

afterAll(() => rm(directory, { recursive: true, force: true }));

test("a cancelled write leaves the existing destination untouched", async () => {
  const path = join(directory, "cancelled.json");

  await writeFile(path, "old");

  const controller = new AbortController();

  controller.abort(new Error("Cancelled"));

  await expect(
    Effect.runPromise(writeResult("new", { path }), {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("old");
});

test("a replacement failure removes its temporary file", async () => {
  const path = join(directory, "is-a-directory");

  await mkdir(path);

  await expect(
    Effect.runPromise(writeResult("{}\n", { path })),
  ).rejects.toThrow("Could not save");
  expect(
    (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
  ).toBe(false);
});

test("stdout failures reject rather than claim success", async () => {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("broken pipe"));
    },
  });

  await expect(Effect.runPromise(writeStream(stream, "{}\n"))).rejects.toThrow(
    "broken pipe",
  );
});

test("cancellation releases a stdout write blocked by its reader", async () => {
  const stream = new Writable({ write() {} });
  const controller = new AbortController();
  const writing = Effect.runPromise(
    writeResult("a pending catalog", { stdout: stream }),
    { signal: controller.signal },
  );

  controller.abort(new Error("Cancelled while writing"));
  await expect(writing).rejects.toThrow();
  expect(stream.destroyed).toBe(true);
});

test("successful file output replaces the destination and removes the sibling", async () => {
  const path = join(directory, "success.json");

  await writeFile(path, "old");

  expect(await Effect.runPromise(writeResult("new", { path }))).toBe(path);
  expect(await readFile(path, "utf8")).toBe("new");
  expect(
    (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
  ).toBe(false);
});

test("no-clobber output creates a complete file and removes the sibling", async () => {
  const path = join(directory, "new-file.json");
  const document = '{"results":[],"total":0}\n';

  expect(
    await Effect.runPromise(writeResult(document, { path, overwrite: false })),
  ).toBe(path);
  expect(await readFile(path, "utf8")).toBe(document);
  expect(
    (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
  ).toBe(false);
});

test("no-clobber conflict retains the destination and exposes EEXIST for confirmation", async () => {
  const path = join(directory, "existing-file.json");

  await writeFile(path, "original");

  const error = await Effect.runPromise(
    Effect.flip(writeResult("replacement", { path, overwrite: false })),
  );

  expect(error._tag).toBe("OutputError");
  expect(error.code).toBe("EEXIST");
  expect(error.message).toContain(path);
  expect(error.message).toContain("confirm overwrite");
  expect(await readFile(path, "utf8")).toBe("original");
  expect(
    (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
  ).toBe(false);
});

test("concurrent no-clobber saves publish exactly one complete result", async () => {
  const path = join(directory, "concurrent-file.json");
  const documents = ["first result\n", "second result\n"];
  const results = await Promise.all(
    documents.map((document) =>
      Effect.runPromiseExit(writeResult(document, { path, overwrite: false })),
    ),
  );
  const winner = results.findIndex(Exit.isSuccess);
  const expected = documents[winner];

  expect(results.filter(Exit.isSuccess)).toHaveLength(1);

  if (expected === undefined) throw new Error("No successful save found");

  expect(await readFile(path, "utf8")).toBe(expected);

  for (const result of results) {
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({
        _tag: "OutputError",
        code: "EEXIST",
      });
    }
  }

  expect(
    (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
  ).toBe(false);
});

test("cleanup failure preserves the original replacement failure", async () => {
  const path = join(directory, "cleanup-failure");

  await mkdir(path);

  const unlink = spyOn(fs, "unlink").mockRejectedValue(
    new Error("unlink denied"),
  );
  const result = await Effect.runPromiseExit(writeResult("new", { path }));
  unlink.mockRestore();

  expect(Exit.isFailure(result)).toBe(true);

  if (Exit.isFailure(result)) {
    const errors = Cause.pretty(result.cause);

    expect(errors).toContain("unlink denied");
    expect(result.cause.reasons.length).toBe(2);
  }

  for (const entry of await readdir(directory)) {
    if (entry.endsWith(".tmp")) await fs.unlink(join(directory, entry));
  }
});

test("stdout waits for a backpressured write callback", async () => {
  let complete: (() => void) | undefined;
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      complete = callback;
    },
  });
  let finished = false;
  const writing = Effect.runPromise(writeStream(stream, "long chunk")).then(
    () => {
      finished = true;
    },
  );

  expect(finished).toBe(false);
  expect(complete).toBeDefined();

  complete?.();
  await writing;

  expect(stream.listenerCount("error")).toBe(0);
  expect(stream.listenerCount("close")).toBe(0);
});

test.each([false, true])(
  "interruption closes and removes the temporary file (overwrite: %s)",
  async (overwrite) => {
    const path = join(directory, `interrupted-${overwrite}.json`);

    await writeFile(path, "old");

    const controller = new AbortController();
    const nativeOpen = fs.open;
    let closed = false;
    const opening = spyOn(fs, "open").mockImplementation((...args) =>
      nativeOpen(...args).then((handle) => {
        const nativeClose = handle.close.bind(handle);

        spyOn(handle, "close").mockImplementation(() =>
          nativeClose().then(() => {
            closed = true;
          }),
        );

        const nativeWrite = handle.writeFile.bind(handle);

        spyOn(handle, "writeFile").mockImplementation((data, options) => {
          controller.abort();

          return nativeWrite(data, options);
        });

        return handle;
      }),
    );
    const result = await Effect.runPromiseExit(
      writeResult("new", { path, overwrite }),
      {
        signal: controller.signal,
      },
    );
    opening.mockRestore();

    expect(Exit.isFailure(result)).toBe(true);
    expect(closed).toBe(true);
    expect(await readFile(path, "utf8")).toBe("old");
    expect(
      (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);
  },
);

test.each([false, true])(
  "close errors remain typed and preserve a primary write error (write failure: %s)",
  async (failWrite) => {
    const path = join(directory, `close-error-${failWrite}.json`);

    await writeFile(path, "old");

    const nativeOpen = fs.open;
    const opening = spyOn(fs, "open").mockImplementation((...args) =>
      nativeOpen(...args).then((handle) => {
        const nativeClose = handle.close.bind(handle);

        spyOn(handle, "close").mockImplementation(() =>
          nativeClose().then(() => {
            throw new Error("close denied");
          }),
        );

        if (failWrite) {
          spyOn(handle, "writeFile").mockRejectedValue(
            new Error("write denied"),
          );
        }

        return handle;
      }),
    );
    const result = await Effect.runPromiseExit(writeResult("new", { path }));
    opening.mockRestore();

    expect(Exit.isFailure(result)).toBe(true);

    if (Exit.isFailure(result)) {
      expect(result.cause.reasons.length).toBe(failWrite ? 2 : 1);

      for (const reason of result.cause.reasons) {
        expect(reason._tag).toBe("Fail");

        if (reason._tag === "Fail")
          expect(reason.error._tag).toBe("OutputError");
      }

      expect(Cause.pretty(result.cause)).toContain("close denied");

      if (failWrite)
        expect(Cause.pretty(result.cause)).toContain("write denied");
    }

    expect(await readFile(path, "utf8")).toBe("old");
    expect(
      (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);
  },
);
