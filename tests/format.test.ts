import { expect, test } from "bun:test";
import { Effect } from "effect";
import { centsToNumber, parseMoney } from "../src/catalog";
import { formatMoney, serializeCatalog } from "../src/format";
import type { Catalog } from "../src/types";

const catalog: Catalog = {
  results: [{ name: "Phone", description: "Small", price: 24.9 }],
  total: 24.9,
};

test("money display pads validated decimal amounts without changing cents", () => {
  for (const [amount, expected] of [
    [0, "0.00"],
    [0.01, "0.01"],
    [24.9, "24.90"],
    [90071992547409.9, "90071992547409.90"],
    [70368744177664.1, "70368744177664.10"],
  ] as const)
    expect(formatMoney(amount)).toBe(expected);
});

test("CSV and TSV preserve cents for large amounts accepted by catalog validation", () => {
  for (const expected of ["90071992547409.90", "70368744177664.10"]) {
    const cents = Effect.runSync(parseMoney(expected));
    const price = Effect.runSync(centsToNumber(cents));
    const input: Catalog = {
      results: [{ name: "Large amount", description: "Exact cents", price }],
      total: price,
    };

    for (const [format, delimiter] of [
      ["csv", ","],
      ["tsv", "\t"],
    ] as const)
      expect(serializeCatalog(input, { format })).toBe(
        [
          ["name", "description", "price", "colors"].join(delimiter),
          ["Large amount", "Exact cents", expected, ""].join(delimiter),
          "",
        ].join("\r\n"),
      );
  }
});

test("default and explicit JSON preserve compact bytes and trailing newline", () => {
  const expected =
    '{"results":[{"name":"Phone","description":"Small","price":24.9}],"total":24.9}\n';

  expect(serializeCatalog(catalog)).toBe(expected);
  expect(serializeCatalog(catalog, { format: "json" })).toBe(expected);
});

test("pretty JSON retains the existing two-space indentation", () => {
  expect(serializeCatalog(catalog, { pretty: true })).toBe(`{
  "results": [
    {
      "name": "Phone",
      "description": "Small",
      "price": 24.9
    }
  ],
  "total": 24.9
}
`);
});

test("unsupported formats cannot silently become TSV", () => {
  expect(() =>
    // JavaScript callers can bypass OutputFormat's compile-time restriction.
    // @ts-expect-error Deliberately exercise an unsupported runtime format.
    serializeCatalog(catalog, { format: "yaml" }),
  ).toThrow("Unsupported output format: yaml");
});

const escapedCatalog: Catalog = {
  results: [
    {
      name: 'Телефон, "Pro"',
      description: 'Line one\r\nLine two\t"quoted"\nLast line',
      price: 24.9,
      colors: ["Чорний", 'Gold, "shiny"'],
    },
    { name: "Basic", description: "Plain, text", price: 0 },
  ],
  total: 24.9,
};

test("CSV uses a header, CRLF records, quoted multiline cells and fixed cents without a total row or BOM", () => {
  expect(serializeCatalog(escapedCatalog, { format: "csv" })).toBe(
    'name,description,price,colors\r\n"Телефон, ""Pro""","Line one\r\nLine two\t""quoted""\nLast line",24.90,"Чорний; Gold, ""shiny"""\r\nBasic,"Plain, text",0.00,\r\n',
  );
});

test("TSV uses CSV-style quoting with tabs as delimiters, CRLF records and literal commas", () => {
  expect(serializeCatalog(escapedCatalog, { format: "tsv" })).toBe(
    'name\tdescription\tprice\tcolors\r\n"Телефон, ""Pro"""\t"Line one\r\nLine two\t""quoted""\nLast line"\t24.90\t"Чорний; Gold, ""shiny"""\r\nBasic\tPlain, text\t0.00\t\r\n',
  );
});

test("tabular text cells mitigate formula prefixes before quoting while prices remain numeric", () => {
  const formulas: Catalog = {
    results: [
      { name: "=1+1", description: "+1", price: 1, colors: ["-Red", "Blue"] },
      { name: "@SUM(A1)", description: "  =1", price: 2 },
      { name: "\ttext", description: "\rtext", price: 3 },
      { name: "\ntext", description: " \t+1", price: 4 },
      { name: "  -1", description: " \n@name", price: 5 },
      { name: "safe=1", description: "  ordinary", price: 6 },
    ],
    total: 21,
  };

  expect(serializeCatalog(formulas, { format: "csv" })).toBe(
    "name,description,price,colors\r\n'=1+1,'+1,1.00,'-Red; Blue\r\n'@SUM(A1),'  =1,2.00,\r\n\"'\ttext\",\"'\rtext\",3.00,\r\n\"'\ntext\",\"' \t+1\",4.00,\r\n'  -1,\"' \n@name\",5.00,\r\nsafe=1,  ordinary,6.00,\r\n",
  );
  expect(serializeCatalog(formulas, { format: "tsv" })).toBe(
    "name\tdescription\tprice\tcolors\r\n'=1+1\t'+1\t1.00\t'-Red; Blue\r\n'@SUM(A1)\t'  =1\t2.00\t\r\n\"'\ttext\"\t\"'\rtext\"\t3.00\t\r\n\"'\ntext\"\t\"' \t+1\"\t4.00\t\r\n'  -1\t\"' \n@name\"\t5.00\t\r\nsafe=1\t  ordinary\t6.00\t\r\n",
  );
});

test("serialization preserves its input, and pretty only affects JSON", () => {
  const input: Catalog = {
    results: [
      { name: "=Phone", description: "Text", price: 10, colors: ["+Gold"] },
    ],
    total: 10,
  };
  const before = structuredClone(input);

  for (const format of ["csv", "tsv"] as const) {
    expect(serializeCatalog(input, { format, pretty: true })).toBe(
      serializeCatalog(input, { format }),
    );
  }

  expect(input).toEqual(before);
  expect(serializeCatalog(input)).toBe(
    '{"results":[{"name":"=Phone","description":"Text","price":10,"colors":["+Gold"]}],"total":10}\n',
  );
});
