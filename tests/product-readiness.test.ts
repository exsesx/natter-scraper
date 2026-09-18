import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { createProductReader } from "../src/product-browser";

setDefaultTimeout(30_000);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("unexpected request", { status: 404 }),
});
const url = `http://127.0.0.1:${server.port}/catalog/product/1`;

afterAll(() => server.stop(true));

test.each([
  { name: "idle network and applied selection", immediate: "" },
  {
    name: "an early DOM acknowledgement",
    immediate: "wrapper.dataset.complete = 'true';",
  },
  {
    name: "an intermediate price",
    immediate: "price.textContent = '$20.22';",
  },
])("waits for the final price despite $name", async ({ immediate }) => {
  // These signals precede the final price; shortening quiet time to 100 ms
  // captures either the original $10.11 or intermediate $20.22 instead.
  const html = `<!doctype html><html><body>
    <div class="test-site"><div class="product-wrapper">
      <h4 class="title">Timing fixture</h4>
      <p class="description">Explicit synthetic prices.</p>
      <h4 class="price">$10.11<meta itemprop="priceCurrency" content="USD"></h4>
      <label class="memory">HDD:</label><div class="swatches">
        <button class="active" value="64">64</button>
        <button value="2048">2 TB</button>
      </div>
    </div></div>
    <script>
      const wrapper = document.querySelector('.product-wrapper');
      const price = document.querySelector('.price');
      const buttons = document.querySelectorAll('.swatches button');
      buttons.forEach(button => button.addEventListener('click', () => {
        buttons.forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        ${immediate}
        setTimeout(() => { price.textContent = '$71.83'; }, 300);
      }));
    </script>
  </body></html>`;
  const product = await Effect.runPromise(
    createProductReader({
      canonical: (raw) => (raw === url ? raw : undefined),
      timeoutMs: 4_000,
    }).pipe(
      Effect.flatMap((read) => read(html, url)),
      Effect.scoped,
    ),
  );

  expect(
    product.variants.map(({ key, priceCents }) => [key, priceCents]),
  ).toEqual([
    ["64", 7183],
    ["2048", 7183],
  ]);
});
