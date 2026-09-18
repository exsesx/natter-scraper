import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  buildCatalog,
  CatalogError,
  centsToNumber,
  parseMoney,
} from "../src/catalog";
import type { SourceProduct } from "../src/types";

const product = (id: string, priceCents = 10): SourceProduct => ({
  id,
  name: "Same model",
  description: "Description",
  colors: [],
  variants: [{ key: "base", priceCents }],
});

describe("exact USD money", () => {
  test.each([
    ["$416.99", 41699],
    ["299", 29900],
    ["0.1", 10],
    ["0", 0],
    [" 12.30 ", 1230],
  ] as const)("parses %s without float arithmetic", (text, cents) => {
    expect(Effect.runSync(parseMoney(text))).toBe(cents);
    expect(
      Effect.runSync(
        parseMoney(JSON.stringify(Effect.runSync(centsToNumber(cents)))),
      ),
    ).toBe(cents);
  });

  test.each([
    "",
    "-1",
    "NaN",
    "$1,000",
    "1.001",
    "1e2",
    "01.00",
    "USD 1",
    "€1",
    "9007199254740992",
  ])("rejects malformed or unsupported %s", (text) => {
    expect(() => Effect.runSync(parseMoney(text))).toThrow();
  });

  test("rejects cent loss even below the safe-integer ceiling", () => {
    expect(() =>
      Effect.runSync(centsToNumber(Number.MAX_SAFE_INTEGER)),
    ).toThrow();
    expect(() => Effect.runSync(centsToNumber(1.1))).toThrow();
    expect(() => Effect.runSync(centsToNumber(-1))).toThrow();

    for (const cents of [1, 29, 99, 123456789, 1000000000000]) {
      expect(
        Effect.runSync(
          parseMoney(JSON.stringify(Effect.runSync(centsToNumber(cents)))),
        ),
      ).toBe(cents);
    }
  });
});

describe("catalog identity and totals", () => {
  test("equal-price products count separately; exact duplicates collapse", () => {
    expect(
      Effect.runSync(buildCatalog([product("b"), product("a"), product("a")])),
    ).toEqual({
      results: [
        { name: "Same model", description: "Description", price: 0.1 },
        { name: "Same model", description: "Description", price: 0.1 },
      ],
      total: 0.2,
    });
  });

  test("variant ordering, suffixes, normalized colors, independent exact total", () => {
    const source: SourceProduct = {
      id: "laptop",
      name: "Model 128",
      description: "500GB source description",
      colors: ["White", " Black ", "White"],
      variants: [
        { key: "512", label: "512GB", priceCents: 45699 },
        { key: "128", label: "128GB", priceCents: 41699 },
        { key: "256", label: "256 GB", priceCents: 43699 },
      ],
    };

    expect(Effect.runSync(buildCatalog([source]))).toEqual({
      results: [
        {
          name: "Model 128 (128 GB)",
          description: "500GB source description",
          price: 416.99,
          colors: ["Black", "White"],
        },
        {
          name: "Model 128 (256 GB)",
          description: "500GB source description",
          price: 436.99,
          colors: ["Black", "White"],
        },
        {
          name: "Model 128 (512 GB)",
          description: "500GB source description",
          price: 456.99,
          colors: ["Black", "White"],
        },
      ],
      total: 1310.97,
    });

    expect(Effect.runSync(buildCatalog([source, product("a")]))).toEqual(
      Effect.runSync(buildCatalog([product("a"), source])),
    );
  });

  test("already-suffixed names and a single color", () => {
    const source = product("a");
    source.name = "Model (128 GB)";
    source.colors = ["Black"];
    source.variants = [{ key: "128", label: "128 GB", priceCents: 10 }];

    expect(Effect.runSync(buildCatalog([source])).results[0]).toEqual({
      name: "Model (128 GB)",
      description: "Description",
      price: 0.1,
    });
  });

  test("conflicts, empty catalog, and missing variants fail", () => {
    expect(() => Effect.runSync(buildCatalog([]))).toThrow("empty");
    expect(() =>
      Effect.runSync(buildCatalog([product("a"), product("a", 20)])),
    ).toThrow("Conflicting");
    expect(() =>
      Effect.runSync(
        buildCatalog([product("a"), { ...product("a"), name: "Changed" }]),
      ),
    ).toThrow("Conflicting");
    expect(() =>
      Effect.runSync(buildCatalog([{ ...product("a"), variants: [] }])),
    ).toThrow("No enabled");
  });

  test("total cannot overflow the supported cents range", () => {
    expect(() =>
      Effect.runSync(
        buildCatalog([
          product("a", 5000000000000000),
          product("b", 5000000000000000),
        ]),
      ),
    ).toThrow("total");
  });

  test("duplicate source pages must agree on available configurations", () => {
    const changed = product("a");
    changed.variants = [{ key: "128", label: "128 GB", priceCents: 10 }];

    expect(() => Effect.runSync(buildCatalog([product("a"), changed]))).toThrow(
      "Conflicting product",
    );
  });
});

test("money and catalog failures use the typed CatalogError channel", () => {
  const operations: Effect.Effect<unknown, CatalogError>[] = [
    parseMoney("$1.001"),
    centsToNumber(-1),
    buildCatalog([]),
  ];

  for (const operation of operations) {
    const error = Effect.runSync(Effect.flip(operation));

    expect(error).toBeInstanceOf(CatalogError);
    expect(error._tag).toBe("CatalogError");
  }
});
