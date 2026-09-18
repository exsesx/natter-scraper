import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { ExtractionError, parseListing, parseProduct } from "../src/site";

const base = "https://webscraper.io/test-sites/e-commerce/static";
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/source/${name}.html`, import.meta.url),
    "utf8",
  );
const laptop = fixture("product-31");
const phone = fixture("product-1");

describe("real source fixtures", () => {
  test("a snapshot reads only the displayed price and discovers enabled storage", () => {
    expect(Effect.runSync(parseProduct(laptop, `${base}/product/31`))).toEqual({
      id: `${base}/product/31`,
      name: "Packard 255 G2",
      description: '15.6", AMD E2-3800 1.3GHz, 4GB, 500GB, Windows 8.1',
      colors: [],
      priceCents: 41699,
      selectedStorage: "128",
      storage: [
        { key: "128", label: "128 GB" },
        { key: "256", label: "256 GB" },
        { key: "512", label: "512 GB" },
      ],
    });
  });

  test("actual color control excludes its placeholder", () => {
    expect(
      Effect.runSync(
        parseProduct(phone, `${base}/product/1?ignored=yes#details`),
      ),
    ).toEqual({
      id: `${base}/product/1`,
      name: "Nokia 123",
      description: "7 day battery",
      priceCents: 2499,
      selectedStorage: undefined,
      storage: [],
      colors: [
        { key: "Gold", label: "Gold" },
        { key: "White", label: "White" },
        { key: "Black", label: "Black" },
      ],
    });
  });

  test("category navigation and pagination preserve next pages and subcategories", () => {
    const listing = Effect.runSync(
      parseListing(fixture("laptops-page-1"), `${base}/computers/laptops`),
    );

    expect(listing.links).toContain(`${base}/computers/tablets`);
    expect(listing.links).toContain(`${base}/computers/laptops?page=2`);
    expect(listing.links).toContain(`${base}/computers/laptops?page=20`);
    expect(listing.productLinks).toHaveLength(6);
    expect(new Set(listing.links).size).toBe(listing.links.length);
    expect(
      listing.productLinks.every((url) => url.startsWith(`${base}/product/`)),
    ).toBe(true);
  });

  test("landing discovers categories and featured products", () => {
    const listing = Effect.runSync(parseListing(fixture("landing"), base));

    expect(listing.links).toContain(`${base}/phones`);
    expect(listing.productLinks.length).toBeGreaterThan(0);
  });
});

describe("synthetic storage availability", () => {
  test("new capacities are discovered without inventing their prices", () => {
    const html = laptop
      .replace('value="1024" disabled=""', 'value="2048"')
      .replace(">1024</button>", ">2048</button>");
    const snapshot = Effect.runSync(parseProduct(html, `${base}/product/31`));

    expect(snapshot.storage.at(-1)).toEqual({ key: "2048", label: "2048 GB" });
    expect(snapshot.priceCents).toBe(41699);
    expect(snapshot).not.toHaveProperty("variants");
  });

  test("one enabled storage option is discovered with its label", () => {
    const html = laptop
      .replace('value="256"', 'value="256" disabled')
      .replace('value="512"', 'value="512" aria-disabled="true"');
    const snapshot = Effect.runSync(parseProduct(html, `${base}/product/31`));

    expect(snapshot.storage).toEqual([{ key: "128", label: "128 GB" }]);
    expect(snapshot.priceCents).toBe(41699);
  });
});

describe("rendered USD precision", () => {
  test.each([
    ["517.1700000000001", 51717],
    ["689.9899999999999", 68999],
    ["0.30000000000000004", 30],
  ] as const)("accepts floating-point display noise in $%s", (price, cents) => {
    const html = laptop.replace("$416.99", `$${price}`);

    expect(
      Effect.runSync(parseProduct(html, `${base}/product/31`)).priceCents,
    ).toBe(cents);
  });

  test.each([
    "517.171",
    "1.001",
    "1.000000001",
    "517.170000000000100001",
    "9000000000000.001",
  ])("rejects fractional cents or lossy decimal text in $%s", (price) => {
    const html = laptop.replace("$416.99", `$${price}`);

    expect(() =>
      Effect.runSync(parseProduct(html, `${base}/product/31`)),
    ).toThrow("Unsupported USD price");
  });
});

describe("synthetic markup changes fail explicitly", () => {
  test("recognizable product cards cannot silently lose their title links", () => {
    const html = fixture("laptops-page-1").replaceAll(
      'class="title"',
      'class="renamed"',
    );

    expect(() =>
      Effect.runSync(parseListing(html, `${base}/computers/laptops`)),
    ).toThrow("product link");
  });

  test("advertised inventory catches a missing card or all pagination", () => {
    const html = fixture("laptops-page-1");

    expect(() =>
      Effect.runSync(
        parseListing(
          html.replace(
            'itemtype="https://schema.org/Product"',
            'itemtype="changed"',
          ),
          `${base}/computers/laptops`,
        ),
      ),
    ).toThrow("card count");
    expect(() =>
      Effect.runSync(
        parseListing(
          html.replace('class="pagination"', 'class="renamed"'),
          `${base}/computers/laptops`,
        ),
      ),
    ).toThrow("pagination");
  });

  test("enabled page controls must retain their destination", () => {
    const html = fixture("laptops-page-1").replace(
      'href="/test-sites/e-commerce/static/computers/laptops?page=2"',
      'data-old="removed"',
    );

    expect(() =>
      Effect.runSync(parseListing(html, `${base}/computers/laptops`)),
    ).toThrow("destination");
  });

  test.each([
    laptop.replace('class="title card-title"', 'class="renamed"'),
    laptop.replace('class="description card-text"', 'class="renamed"'),
    laptop.replace("$416.99", "$416.999"),
    laptop.replace('content="USD"', 'content="EUR"'),
    laptop.replace('value="256"', 'value=""'),
    laptop.replace('value="128"', 'value="256"'),
    laptop.replaceAll('class="btn swatch', 'disabled class="btn swatch'),
    phone.replace('aria-label="color"', 'aria-label="warranty"'),
    phone.replaceAll("select", "ul").replaceAll("option", "li"),
  ])("rejects missing or unverified data", (html) => {
    expect(() =>
      Effect.runSync(parseProduct(html, `${base}/product/31`)),
    ).toThrow();
  });

  test("disabled and duplicate colors normalize without treating text as controls", () => {
    const changed = phone
      .replace('value="White"', 'disabled value="White"')
      .replace("</select>", '<option value="Gold"> Gold </option></select>');

    expect(
      Effect.runSync(parseProduct(changed, `${base}/product/1`)).colors,
    ).toEqual([
      { key: "Gold", label: "Gold" },
      { key: "Black", label: "Black" },
    ]);
  });

  test("unexpected landing and non-product link cannot silently succeed", () => {
    expect(() =>
      Effect.runSync(parseListing("<html>Oops</html>", base)),
    ).toThrow("navigation");
    expect(() =>
      Effect.runSync(
        parseListing(
          '<div class="test-site"><ul id="side-menu"></ul><a class="title" href="/login">x</a></div>',
          base,
        ),
      ),
    ).toThrow("product link");
  });
});

test("extraction failures include source context in the typed error channel", () => {
  const url = `${base}/product/31`;
  const operations: Effect.Effect<unknown, ExtractionError>[] = [
    parseListing("<html>Oops</html>", url),
    parseProduct(laptop.replace("$416.99", "$416.999"), url),
    parseProduct(laptop, "invalid-url"),
  ];

  for (const operation of operations) {
    const error = Effect.runSync(Effect.flip(operation));

    expect(error).toBeInstanceOf(ExtractionError);
    expect(error._tag).toBe("ExtractionError");
  }

  const error = Effect.runSync(
    Effect.flip(parseProduct(laptop.replace("$416.99", "$416.999"), url)),
  );

  expect(error.url).toBe(url);
  expect(error.message).toContain("Unsupported USD price");
});
