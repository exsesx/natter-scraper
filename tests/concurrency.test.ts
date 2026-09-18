import { describe, expect, test } from "bun:test";
import { defaultConcurrency } from "../src/concurrency";

const gib = 1024 ** 3;

describe("default product concurrency", () => {
  test.each([
    { name: "weak", cpus: 2, memoryBytes: 2 * gib, expected: 1 },
    { name: "medium", cpus: 4, memoryBytes: 8 * gib, expected: 4 },
    { name: "strong", cpus: 10, memoryBytes: 16 * gib, expected: 6 },
    { name: "CPU bound", cpus: 2, memoryBytes: 64 * gib, expected: 2 },
    { name: "RAM bound", cpus: 16, memoryBytes: 6 * gib, expected: 3 },
    { name: "capped", cpus: 64, memoryBytes: 128 * gib, expected: 6 },
    { name: "partial CPU", cpus: 3.9, memoryBytes: 64 * gib, expected: 3 },
    { name: "partial RAM budget", cpus: 16, memoryBytes: 5 * gib, expected: 2 },
    { name: "below RAM budget", cpus: 2, memoryBytes: gib, expected: 1 },
    { name: "below one CPU", cpus: 0.5, memoryBytes: 8 * gib, expected: 1 },
  ])(
    "uses $expected slots for $name resources",
    ({ cpus, memoryBytes, expected }) => {
      expect(defaultConcurrency({ cpus, memoryBytes })).toBe(expected);
    },
  );

  test.each([0, -1, NaN, Infinity, -Infinity])(
    "falls back to one slot for invalid resource %s",
    (invalid) => {
      expect(defaultConcurrency({ cpus: invalid, memoryBytes: 16 * gib })).toBe(
        1,
      );
      expect(defaultConcurrency({ cpus: 8, memoryBytes: invalid })).toBe(1);
    },
  );
});
