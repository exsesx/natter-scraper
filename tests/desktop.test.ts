import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createDesktopActions } from "../src/desktop";

test("desktop helpers receive exact content and the containing folder as data", async () => {
  const copied: string[] = [];
  const opened: string[] = [];
  const actions = createDesktopActions(
    async (text) => {
      copied.push(text);
    },
    async (directory) => {
      opened.push(directory);
    },
  );
  const json = '{\n  "results": [], "total": 0\n}\n';
  const directory = join(tmpdir(), "a folder");
  const path = join(directory, "$(touch nope).json");

  await Effect.runPromise(actions.copy(json));
  await Effect.runPromise(actions.copy(path));
  await Effect.runPromise(actions.openFolder(path));

  expect(copied).toEqual([json, path]);
  expect(opened).toEqual([directory]);
});

test("desktop failures propagate to the completion screen", async () => {
  const actions = createDesktopActions(async () => {
    throw new Error("Clipboard unavailable");
  });

  await expect(Effect.runPromise(actions.copy("JSON"))).rejects.toThrow(
    "Clipboard unavailable",
  );
});
