import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createDesktopActions } from "../src/desktop";

test("desktop helpers receive exact content, file paths, and containing folders as data", async () => {
  const copied: string[] = [];
  const opened: string[] = [];
  const actions = createDesktopActions(
    async (text) => {
      copied.push(text);
    },
    async (path) => {
      opened.push(path);
    },
  );
  const json = '{\n  "results": [], "total": 0\n}\n';
  const directory = join(tmpdir(), "a folder");
  const path = join(directory, "$(touch nope).json");

  await Effect.runPromise(actions.copy(json));
  await Effect.runPromise(actions.copy(path));
  await Effect.runPromise(actions.openFile(path));
  await Effect.runPromise(actions.openFolder(path));

  expect(copied).toEqual([json, path]);
  expect(opened).toEqual([path, directory]);
});

test("desktop failures propagate to the completion screen", async () => {
  const actions = createDesktopActions(
    async () => {
      throw new Error("Clipboard unavailable");
    },
    async () => {
      throw new Error("Desktop opener unavailable");
    },
  );

  await expect(Effect.runPromise(actions.copy("JSON"))).rejects.toThrow(
    "Clipboard unavailable",
  );

  for (const action of [actions.openFile, actions.openFolder]) {
    const error = await Effect.runPromise(
      Effect.flip(action(join(tmpdir(), "catalog.json"))),
    );

    expect(error._tag).toBe("DesktopError");
    expect(error.message).toBe("Desktop opener unavailable");
    expect(error.cause).toBeInstanceOf(Error);
  }
});
