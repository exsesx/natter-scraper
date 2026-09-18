import assert from "node:assert/strict";
import { Effect } from "effect";
import { crawl } from "../src/crawl";
import type { Catalog, ResultItem } from "../src/types";

const prefix = "/test-sites/e-commerce/static";
const ids = Array.from({ length: 12 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);

// Three repetitions of plain, storage, color, and storage-with-color products.
function productPage(id: string): string {
  const kind = (Number(id) - 1) % 4;
  const storage = kind === 1 || kind === 3;
  const colors = kind === 2 || kind === 3;

  return `<!doctype html><html><body>
    <div class="test-site"><div class="product-wrapper">
      <h4 class="title">Product ${id}</h4>
      <p class="description">Synthetic benchmark product.</p>
      <h4 class="price">$10.11</h4>
      <meta itemprop="priceCurrency" content="USD">
      ${
        storage
          ? `<label class="memory">HDD:</label><div class="swatches">
        <button value="128" class="active">128</button>
        <button value="256">256</button><button value="512">512</button>
      </div>`
          : ""
      }
      ${
        colors
          ? `<div class="dropdown"><select aria-label="color"><option value="">Select color</option>
        <option value="White">White</option><option value="Black">Black</option>
      </select></div>`
          : ""
      }
    </div></div>
    <script>
      const observedPrices = { "128": "$10.11", "256": "$37.29", "512": "$37.29" };
      document.querySelectorAll('.swatches button').forEach(button => {
        button.addEventListener('click', () => {
          document.querySelectorAll('.swatches button').forEach(item => item.classList.remove('active'));
          button.classList.add('active');
          document.querySelector('.price').textContent = observedPrices[button.value];
        });
      });
    </script>
  </body></html>`;
}

// Independent expectations, without invoking the extraction or catalog builder.
const expectedRows: ResultItem[] = [];

for (const id of ids) {
  const storage = ["02", "04", "06", "08", "10", "12"].includes(id);
  const colors = ["03", "04", "07", "08", "11", "12"].includes(id);
  const variants = storage
    ? [
        { suffix: " (128 GB)", cents: 1011 },
        { suffix: " (256 GB)", cents: 3729 },
        { suffix: " (512 GB)", cents: 3729 },
      ]
    : [{ suffix: "", cents: 1011 }];

  for (const variant of variants)
    expectedRows.push({
      name: `Product ${id}${variant.suffix}`,
      description: "Synthetic benchmark product.",
      price: variant.cents / 100,
      ...(colors ? { colors: ["Black", "White"] } : {}),
    });
}

// Six single-row products plus six three-row products, including equal prices.
const expectedCents = 6 * 1011 + 6 * (1011 + 3729 + 3729);
const expected: Catalog = { results: expectedRows, total: expectedCents / 100 };
const pages = new Map(
  ids.map((id) => [`${prefix}/product/${id}`, productPage(id)]),
);
pages.set(
  prefix,
  `<div class="test-site"><div id="side-menu"></div>${ids.map((id) => `<a class="title" href="${prefix}/product/${id}">Product ${id}</a>`).join("")}</div>`,
);
const warmupPath = `${prefix}/warmup`;
pages.set(
  warmupPath,
  `<div class="test-site"><div id="side-menu"></div><a class="title" href="${warmupPath}/product/01">Product 01</a></div>`,
);
pages.set(`${warmupPath}/product/01`, productPage("01"));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const page = pages.get(new URL(request.url).pathname);

    return new Response(page ?? "Missing", {
      status: page === undefined ? 404 : 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

async function measure(concurrency: number) {
  let retries = 0;
  const started = performance.now();
  const result = await Effect.runPromise(
    crawl({
      baseUrl: `${origin}${prefix}`,
      concurrency,
      fetch: (input, init) => {
        assert.equal(
          new URL(input).origin,
          origin,
          "Only loopback requests are allowed",
        );

        return fetch(input, init);
      },
      onProgress: (progress) => {
        retries = progress.retries;
      },
    }),
  );
  const elapsedMs = performance.now() - started;

  assert.equal(result.productCount, 12);
  assert.equal(result.pages, 13);
  assert.deepEqual(result.catalog, expected);
  assert.equal(
    result.catalog.results.reduce(
      (sum, item) => sum + Math.round(item.price * 100),
      0,
    ),
    expectedCents,
  );

  return {
    concurrency,
    elapsedMs,
    products: result.productCount,
    results: result.catalog.results.length,
    total: result.catalog.total,
    retries,
  };
}

try {
  console.error(
    "Warming up the browser against the synthetic loopback catalog…",
  );
  const warmup = await Effect.runPromise(
    crawl({ baseUrl: `${origin}${warmupPath}`, concurrency: 1 }),
  );
  assert.equal(warmup.productCount, 1);
  assert.deepEqual(warmup.catalog, {
    results: [expectedRows[0]],
    total: 10.11,
  });

  const measurements = [];

  for (const [index, order] of [
    [2, 4, 6, 8],
    [8, 6, 4, 2],
  ].entries()) {
    for (const concurrency of order) {
      console.error(`Round ${index + 1}, concurrency ${concurrency}…`);
      measurements.push({ round: index + 1, ...(await measure(concurrency)) });
    }
  }

  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  server.stop(true);
}
