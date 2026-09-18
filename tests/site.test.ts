import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { buildCatalog } from "../src/catalog";
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
  test("storage prices, disabled capacity, and description are separate facts", () => {
    expect(Effect.runSync(parseProduct(laptop, `${base}/product/31`))).toEqual({
      id: `${base}/product/31`,
      name: "Packard 255 G2",
      description: '15.6", AMD E2-3800 1.3GHz, 4GB, 500GB, Windows 8.1',
      colors: [],
      variants: [
        { key: "128", label: "128 GB", priceCents: 41699 },
        { key: "256", label: "256 GB", priceCents: 43699 },
        { key: "512", label: "512 GB", priceCents: 45699 },
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
      variants: [{ key: "base", priceCents: 2499 }],
      colors: ["Black", "Gold", "White"],
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
  test("enabled 1024 GB retains numeric ordering and adds exactly $60", () => {
    const html = laptop.replace('value="1024" disabled=""', 'value="1024"');
    const catalog = Effect.runSync(
      parseProduct(html, `${base}/product/31`).pipe(
        Effect.flatMap((product) => buildCatalog([product])),
      ),
    );

    expect(catalog).toEqual({
      results: [
        {
          name: "Packard 255 G2 (128 GB)",
          description: '15.6", AMD E2-3800 1.3GHz, 4GB, 500GB, Windows 8.1',
          price: 416.99,
        },
        {
          name: "Packard 255 G2 (256 GB)",
          description: '15.6", AMD E2-3800 1.3GHz, 4GB, 500GB, Windows 8.1',
          price: 436.99,
        },
        {
          name: "Packard 255 G2 (512 GB)",
          description: '15.6", AMD E2-3800 1.3GHz, 4GB, 500GB, Windows 8.1',
          price: 456.99,
        },
        {
          name: "Packard 255 G2 (1024 GB)",
          description: '15.6", AMD E2-3800 1.3GHz, 4GB, 500GB, Windows 8.1',
          price: 476.99,
        },
      ],
      total: 1787.96,
    });
  });

  test("one enabled storage option still gets its suffix and counts once", () => {
    const html = laptop
      .replace('value="256"', 'value="256" disabled')
      .replace('value="512"', 'value="512" aria-disabled="true"');
    const catalog = Effect.runSync(
      parseProduct(html, `${base}/product/31`).pipe(
        Effect.flatMap((product) => buildCatalog([product])),
      ),
    );

    expect(catalog).toEqual({
      results: [
        {
          name: "Packard 255 G2 (128 GB)",
          description: '15.6", AMD E2-3800 1.3GHz, 4GB, 500GB, Windows 8.1',
          price: 416.99,
        },
      ],
      total: 416.99,
    });
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
    laptop.replace('value="256"', 'value="2048"'),
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
    ).toEqual(["Black", "Gold"]);
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
