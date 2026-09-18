import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { InputError, readCatalog } from "../src/input";

const directory = await mkdtemp(join(tmpdir(), "natter-input-"));
let sequence = 0;
const row = { name: "Model", description: "", price: 1.23 };

async function load(value: unknown, raw = false) {
  const path = join(directory, `catalog-${sequence++}.json`);
  await writeFile(path, raw ? String(value) : JSON.stringify(value));

  return Effect.runPromise(readCatalog(path));
}

afterAll(() => rm(directory, { recursive: true, force: true }));

describe("saved JSON catalogs", () => {
  test("preserves row order, duplicate rows, text, and color order", async () => {
    const first = {
      name: " Z model ",
      description: "First line\nSecond line",
      price: 0.1,
      colors: ["White", "Black"],
    };
    const catalog = {
      results: [first, { ...row, name: "A model", price: 0.2 }, first],
      total: 0.4,
    };

    expect(await load(catalog)).toEqual(catalog);
  });

  test("allows empty catalogs and zero-priced rows", async () => {
    expect(await load({ results: [], total: 0 })).toEqual({
      results: [],
      total: 0,
    });
    expect(await load({ results: [{ ...row, price: 0 }], total: 0 })).toEqual({
      results: [{ ...row, price: 0 }],
      total: 0,
    });
  });

  test.each(
    [
      null,
      [],
      {},
      { results: [], total: 0, extra: true },
      { results: {}, total: 0 },
      { results: [null], total: 0 },
      { results: [{ ...row, extra: true }], total: 1.23 },
      { results: [{ description: "", price: 1.23 }], total: 1.23 },
      { results: [{ name: "", description: "", price: 1.23 }], total: 1.23 },
      { results: [{ name: "Model", price: 1.23 }], total: 1.23 },
      { results: [{ ...row, description: null }], total: 1.23 },
      { results: [{ ...row, price: "1.23" }], total: 1.23 },
      { results: [{ ...row, price: -1 }], total: 0 },
      { results: [{ ...row, price: 1.231 }], total: 1.231 },
      { results: [{ ...row, price: 1e-7 }], total: 1e-7 },
      {
        results: [{ ...row, price: 100_000_000_000_000 }],
        total: 100_000_000_000_000,
      },
      { results: [row], total: "1.23" },
      { results: [row], total: -1 },
      { results: [row], total: 1.231 },
      { results: [row], total: 1.24 },
      { results: [], total: 1 },
      { results: [{ ...row, colors: [] }], total: 1.23 },
      { results: [{ ...row, colors: ["Black"] }], total: 1.23 },
      { results: [{ ...row, colors: ["Black", "Black"] }], total: 1.23 },
      { results: [{ ...row, colors: ["Black", ""] }], total: 1.23 },
      { results: [{ ...row, colors: ["Black", 2] }], total: 1.23 },
      { results: [{ ...row, colors: null }], total: 1.23 },
    ].map((value) => ({ value })),
  )("rejects invalid catalog %#", async ({ value }) => {
    await expect(load(value)).rejects.toThrow("Invalid catalog");
  });

  test("rejects an unsafe summed total without rounding it", async () => {
    await expect(
      load({
        results: [
          { ...row, price: 50_000_000_000_000 },
          { ...row, price: 50_000_000_000_000 },
        ],
        total: 0,
      }),
    ).rejects.toThrow("sum of prices exceeds the safe cents range");
  });

  test("rejects numeric overflow in otherwise valid JSON", async () => {
    await expect(load('{"results":[],"total":1e400}', true)).rejects.toThrow(
      "total must be a nonnegative finite number",
    );
  });

  test.each(["1.00000000000000001", "90071992547409.91", "1e-400", "-1e-400"])(
    "rejects parse-time precision loss in %s",
    async (amount) => {
      const rounded = String(JSON.parse(amount));

      await expect(
        load(
          `{"results":[{"name":"Model","description":"","price":${amount}}],"total":${rounded}}`,
          true,
        ),
      ).rejects.toThrow(
        "results[0].price cannot retain its exact value at cent precision",
      );
      await expect(
        load(
          `{"results":[{"name":"Model","description":"","price":${rounded}}],"total":${amount}}`,
          true,
        ),
      ).rejects.toThrow(
        "total cannot retain its exact value at cent precision",
      );
    },
  );

  test.each([
    "1.2300",
    "123e-2",
    "1.23e2",
    "0.001e1",
    "1E+2",
    "-0.000e999",
    "0e-400",
    "90071992547409.90",
    "70368744177664.10",
    "900719925474099e-1",
  ])("retains exact cents written as %s", async (amount) => {
    const expected = JSON.parse(amount);

    expect(
      await load(
        `{"results":[{"name":"Model","description":"","price":${amount}}],"total":${amount}}`,
        true,
      ),
    ).toEqual({
      results: [{ name: "Model", description: "", price: expected }],
      total: expected,
    });
  });

  test("reports malformed JSON separately from read and validation errors", async () => {
    await expect(load("name,price\nModel,1.23", true)).rejects.toThrow(
      "Could not parse JSON",
    );
    const failure = await Effect.runPromise(
      Effect.flip(readCatalog(join(directory, "missing.json"))),
    );

    expect(failure).toBeInstanceOf(InputError);
    expect(failure.message).toContain("Could not read");
    expect(failure.message).toContain("missing.json");
    expect(failure.message).toContain("Check the path and read permissions");
  });
});
