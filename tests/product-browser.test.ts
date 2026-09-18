import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { Effect } from "effect";
import { buildCatalog } from "../src/catalog";
import { createProductReader } from "../src/product-browser";

setDefaultTimeout(60_000);

// Explicit synthetic prices differ from the public site's old increments.
const storage = `<label class="memory">HDD:</label><div class="swatches">
  <button class="active" value="64">64</button>
  <button value="2048">2 TB</button>
  <button value="4096">4 TB</button>
  <button value="8192" disabled>8 TB</button>
</div>`;
const colors = `<div class="dropdown"><select aria-label="color">
  <option value="">Select color</option><option value="black">Black</option>
  <option value="gold">Gold</option><option value="white" disabled>White</option>
</select></div>`;
const switches = `
  const buttons = document.querySelectorAll('.swatches button');
  buttons.forEach(button => button.addEventListener('click', () => {
    buttons.forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    document.querySelector('.price').textContent = {64:'$10.11',2048:'$37.29',4096:'$37.29'}[button.value];
  }));
`;
const product = (controls = "", script = "") => `<!doctype html><html><body>
<div class="test-site"><div class="product-wrapper">
<h4 class="title">Observed model</h4><p class="description">Original description.</p>
<h4 class="price">$10.11<meta itemprop="priceCurrency" content="USD"></h4>
${controls}</div></div><script>${script}</script></body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/price") {
      await Bun.sleep(800);

      return Response.json({ price: "$71.83" });
    }

    return new Response("unexpected request", { status: 404 });
  },
});
const url = `http://127.0.0.1:${server.port}/catalog/product/1`;
const reader = createProductReader({
  canonical: (raw) => (raw === url ? raw : undefined),
  timeoutMs: 15_000,
});
const read = (html: string, signal?: AbortSignal) =>
  Effect.runPromise(
    reader.pipe(
      Effect.flatMap((readProduct) => readProduct(html, url)),
      Effect.flatMap((source) => buildCatalog([source])),
      Effect.scoped,
    ),
    { signal },
  );

afterAll(() => server.stop(true));

describe("browser-observed product configurations", () => {
  test("rejects multiple product wrappers instead of reading only the first", async () => {
    const html = product(
      "",
      `const wrapper = document.querySelector('.product-wrapper');
      wrapper.after(wrapper.cloneNode(true));`,
    );

    await expect(read(html)).rejects.toThrow("Expected one product detail");
  });

  test("completed documents leave without entering the back/forward cache", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const readProduct = yield* reader;
        yield* readProduct(
          product(
            "",
            `localStorage.removeItem('previousPagePersisted');
            window.addEventListener('pagehide', event => {
              localStorage.setItem('previousPagePersisted', String(event.persisted));
            });`,
          ),
          url,
        );

        return yield* readProduct(
          product(
            "",
            `const persisted = localStorage.getItem('previousPagePersisted');
            localStorage.removeItem('previousPagePersisted');
            if (persisted !== 'false') throw new Error('Previous document was cached: ' + persisted);`,
          ),
          url,
        );
      }).pipe(Effect.scoped),
    );

    expect(result.variants[0]?.priceCents).toBe(1011);
  });

  test("a new product clears tab state written by the previous document's pagehide handler", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const readProduct = yield* reader;
        yield* readProduct(
          product(
            "",
            `window.addEventListener('pagehide', () => {
              sessionStorage.setItem('latePreviousProduct', 'true');
              window.name = 'latePreviousProduct';
            });`,
          ),
          url,
        );

        return yield* readProduct(
          product(
            "",
            `if (window.name || sessionStorage.getItem('latePreviousProduct'))
              throw new Error('Previous pagehide state leaked');`,
          ),
          url,
        );
      }).pipe(Effect.scoped),
    );

    expect(result.variants[0]?.priceCents).toBe(1011);
  });

  test("reuses one view across products, clears page state, and closes it with the reader scope", async () => {
    const views = new Set<Bun.WebView>();
    const navigate = Bun.WebView.prototype.navigate;
    const observed = spyOn(
      Bun.WebView.prototype,
      "navigate",
    ).mockImplementation(function (this: Bun.WebView, destination: string) {
      views.add(this);

      return navigate.call(this, destination);
    });

    try {
      const sources = await Effect.runPromise(
        Effect.gen(function* () {
          const secondUrl = `${url}0`;
          const readProduct = yield* createProductReader({
            canonical: (raw) =>
              raw === url || raw === secondUrl ? raw : undefined,
            timeoutMs: 15_000,
          });
          const first = yield* readProduct(
            product(
              "",
              "window.previousProduct = true; window.name = 'previous'; sessionStorage.setItem('previousProduct', 'true')",
            ),
            secondUrl,
          );
          const second = yield* readProduct(
            product(
              "",
              "if (window.previousProduct || window.name || sessionStorage.getItem('previousProduct')) throw new Error('Previous product leaked'); document.querySelector('.title').textContent = 'Second model'",
            ),
            url,
          );

          return [first.name, second.name];
        }).pipe(Effect.scoped),
      );

      expect(sources).toEqual(["Observed model", "Second model"]);
      expect(views.size).toBe(1);

      for (const view of views)
        expect(() => view.evaluate("document.title")).toThrow();
    } finally {
      observed.mockRestore();
    }
  });

  test.each(["rejection", "timeout"] as const)(
    "cleanup %s preserves the observed product and discards the view",
    async (failure) => {
      const views = new Set<Bun.WebView>();
      const loaded = new Set<Bun.WebView>();
      const navigate = Bun.WebView.prototype.navigate;
      let discarded: Bun.WebView | undefined;
      const observed = spyOn(
        Bun.WebView.prototype,
        "navigate",
      ).mockImplementation(function (this: Bun.WebView, destination: string) {
        views.add(this);

        if (destination !== "about:blank") loaded.add(this);
        else if (loaded.has(this) && !discarded) {
          discarded = this;

          // A real pending operation rejects when the timeout closes the view.
          return failure === "timeout"
            ? this.evaluate("new Promise(() => {})").then(() => {})
            : Promise.reject(new Error("Synthetic cleanup rejection"));
        }

        return navigate.call(this, destination);
      });

      try {
        const catalogs = await Effect.runPromise(
          Effect.gen(function* () {
            const readProduct = yield* createProductReader({
              canonical: (raw) => (raw === url ? raw : undefined),
              timeoutMs: 15_000,
            });
            const first = yield* readProduct(product(), url);

            expect(discarded).toBeDefined();
            expect(() => discarded?.evaluate("document.title")).toThrow();

            const second = yield* readProduct(product(), url);

            return yield* Effect.all([
              buildCatalog([first]),
              buildCatalog([second]),
            ]);
          }).pipe(Effect.scoped),
        );

        expect(catalogs[0]).toEqual(catalogs[1]);
        expect(catalogs[0]?.total).toBe(10.11);
        expect(views.size).toBe(2);

        for (const view of views)
          expect(() => view.evaluate("document.title")).toThrow();
      } finally {
        observed.mockRestore();
      }
    },
  );

  test.each(["cancellation", "source error"] as const)(
    "%s during cleanup still rejects the product",
    async (failure) => {
      const controller = new AbortController();
      const navigate = Bun.WebView.prototype.navigate;
      let loaded = false;
      let cleanupView: Bun.WebView | undefined;
      const observed = spyOn(
        Bun.WebView.prototype,
        "navigate",
      ).mockImplementation(function (this: Bun.WebView, destination: string) {
        if (destination !== "about:blank") loaded = true;
        else if (loaded) {
          cleanupView = this;

          if (failure === "cancellation") controller.abort();
          else
            this.dispatchEvent(
              Object.assign(new Event("Runtime.exceptionThrown"), {
                data: { exceptionDetails: { text: "Source cleanup failure" } },
              }),
            );

          return Promise.reject(new Error("Synthetic cleanup rejection"));
        }

        return navigate.call(this, destination);
      });

      try {
        const pending = read(product(), controller.signal);

        if (failure === "source error")
          await expect(pending).rejects.toThrow("Source cleanup failure");
        else await expect(pending).rejects.toThrow();

        expect(cleanupView).toBeDefined();
        expect(() => cleanupView?.evaluate("document.title")).toThrow();
      } finally {
        observed.mockRestore();
      }
    },
  );

  test("reused views require fresh currency evidence and recover after a failed product", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const readProduct = yield* reader;
        yield* readProduct(product(), url);

        const failure = yield* Effect.flip(
          readProduct(
            product().replace(
              '<meta itemprop="priceCurrency" content="USD">',
              "",
            ),
            url,
          ),
        );
        const recovered = yield* readProduct(
          product().replace("$10.11", "$23.45"),
          url,
        );

        return {
          message: failure.message,
          price: recovered.variants[0]?.priceCents,
        };
      }).pipe(Effect.scoped),
    );

    expect(outcomes.message).toContain("Unsupported or missing currency");
    expect(outcomes.price).toBe(2345);
  });

  test("discovers new capacities, reads actual prices, keeps equal-price identities and excludes disabled options", async () => {
    expect(await read(product(storage, switches))).toEqual({
      results: [
        {
          name: "Observed model (64 GB)",
          description: "Original description.",
          price: 10.11,
        },
        {
          name: "Observed model (2 TB)",
          description: "Original description.",
          price: 37.29,
        },
        {
          name: "Observed model (4 TB)",
          description: "Original description.",
          price: 37.29,
        },
      ],
      total: 84.69,
    });
  });

  test("each storage selection checks its available colors without multiplying rows", async () => {
    const changeColors = `
      document.querySelectorAll('.swatches button').forEach(button => button.addEventListener('click', () => {
        document.querySelector('option[value=gold]').disabled = button.value === '4096';
      }));
      document.querySelector('select').addEventListener('change', event => {
        document.querySelector('.title').textContent = 'Observed model ' + event.target.value;
      });
    `;
    const catalog = await read(
      product(storage + colors, switches + changeColors),
    );

    expect(catalog.total).toBe(84.69);
    expect(catalog.results.map((item) => item.colors)).toEqual([
      ["Black", "Gold"],
      ["Black", "Gold"],
      undefined,
    ]);
    expect(catalog.results.map((item) => item.name)).toEqual([
      "Observed model (64 GB)",
      "Observed model (2 TB)",
      "Observed model (4 TB)",
    ]);
  });

  test("reads prices produced by floating-point page arithmetic in exact cents", async () => {
    const arithmetic = switches.replace(
      "{64:'$10.11',2048:'$37.29',4096:'$37.29'}[button.value]",
      () => "'$' + (497.17 + {64:0,2048:20,4096:39}[button.value])",
    );
    const catalog = await read(
      product(storage, arithmetic).replace("$10.11", "$497.17"),
    );

    expect(catalog.results.map((item) => item.price)).toEqual([
      497.17, 517.17, 536.17,
    ]);
    expect(catalog.total).toBe(1550.51);
  });

  test.each(["price", "description"])(
    "a color changing %s fails rather than hiding the difference in a colors array",
    async (field) => {
      await expect(
        read(
          product(
            colors,
            `
      document.querySelector('select').addEventListener('change', event => {
        document.querySelector('.${field}').textContent = event.target.value === 'black' ? '$10.11' : '$18.12';
      });
    `,
          ),
        ),
      ).rejects.toThrow("Colors have different prices");
    },
  );

  test("requires initial USD evidence and rejects a changed currency after selection", async () => {
    await expect(
      read(product().replace('content="USD"', 'content="EUR"')),
    ).rejects.toThrow("Unsupported or missing currency");
    await expect(
      read(
        product().replace('<meta itemprop="priceCurrency" content="USD">', ""),
      ),
    ).rejects.toThrow("Unsupported or missing currency");
    await expect(
      read(
        product(
          storage,
          switches +
            `
      document.querySelector('button').addEventListener('click', () => {
        document.querySelector('.price').insertAdjacentHTML('beforeend', '<meta itemprop="priceCurrency" content="EUR">');
      });
    `,
        ),
      ),
    ).rejects.toThrow("Unsupported or missing currency");
  });

  test("waits for asynchronous pricing requests without requiring a busy marker", async () => {
    const delayed = `
      document.querySelectorAll('.swatches button').forEach(button => button.addEventListener('click', async () => {
        document.querySelectorAll('button').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        const data = await fetch('/price').then(response => response.json());
        document.querySelector('.price').textContent = data.price;
      }));
    `;
    const one = storage
      .replace('<button value="2048">', '<button disabled value="2048">')
      .replace('<button value="4096">', '<button disabled value="4096">');

    expect((await read(product(one, delayed))).total).toBe(71.83);
  });

  test("storage observations retain changed names and descriptions", async () => {
    const observed = await read(
      product(
        storage,
        switches +
          `
      document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        document.querySelector('.title').textContent = 'Model ' + button.value;
        document.querySelector('.description').textContent = 'Description ' + button.value;
      }));
    `,
      ),
    );

    expect(
      observed.results.map(({ name, description }) => [name, description]),
    ).toEqual([
      ["Model 64 (64 GB)", "Description 64"],
      ["Model 2048 (2 TB)", "Description 2048"],
      ["Model 4096 (4 TB)", "Description 4096"],
    ]);
  });

  test.each(["price", "description"])(
    "storage reloads isolate history-dependent %s even without colors",
    async (field) => {
      const observed = await read(
        product(
          storage,
          switches +
            `
      let clicks = 0;
      document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        clicks += 1;
        if (clicks > 1) document.querySelector('.${field}').textContent = ${JSON.stringify(field === "price" ? "$99.99" : "Previous selection leaked.")};
      }));
    `,
        ),
      );

      expect(observed.results.map((item) => item.price)).toEqual([
        10.11, 37.29, 37.29,
      ]);
      expect(observed.results.map((item) => item.description)).toEqual([
        "Original description.",
        "Original description.",
        "Original description.",
      ]);
    },
  );

  test("storage reloads prevent color names and descriptions carrying into the next storage choice", async () => {
    const observed = await read(
      product(
        storage + colors,
        switches +
          `
      document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        document.querySelector('.description').textContent += ' Storage ' + button.value + '.';
      }));
      document.querySelector('select').addEventListener('change', event => {
        document.querySelector('.title').textContent = 'Observed model ' + event.target.value;
      });
    `,
      ),
    );

    expect(observed.results).toEqual([
      {
        name: "Observed model (64 GB)",
        description: "Original description. Storage 64.",
        price: 10.11,
        colors: ["Black", "Gold"],
      },
      {
        name: "Observed model (2 TB)",
        description: "Original description. Storage 2048.",
        price: 37.29,
        colors: ["Black", "Gold"],
      },
      {
        name: "Observed model (4 TB)",
        description: "Original description. Storage 4096.",
        price: 37.29,
        colors: ["Black", "Gold"],
      },
    ]);
  });

  test("each storage reload requires fresh currency and unchanged availability", async () => {
    const laterLoad = `
      const loads = Number(sessionStorage.getItem('loads') || 0) + 1;
      sessionStorage.setItem('loads', String(loads));
    `;

    await expect(
      read(
        product(
          storage,
          switches +
            laterLoad +
            `if (loads > 1) document.querySelector('[itemprop="priceCurrency"]').remove();`,
        ),
      ),
    ).rejects.toThrow("Unsupported or missing currency");
    await expect(
      read(
        product(
          storage,
          switches +
            laterLoad +
            `if (loads > 1) document.querySelector('button[value="4096"]').disabled = true;`,
        ),
      ),
    ).rejects.toThrow("Storage availability changed between observations");
  });

  test("delayed DOM updates restart the full observation window for each storage choice", async () => {
    const observed = await read(
      product(
        storage,
        switches +
          `
      document.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
        setTimeout(() => {
          document.querySelector('.price').textContent = {64:'$12.34',2048:'$45.67',4096:'$89.01'}[button.value];
          document.querySelector('.description').textContent = 'Settled ' + button.value;
        }, 350);
      }));
    `,
      ),
    );

    expect(
      observed.results.map(({ price, description }) => [price, description]),
    ).toEqual([
      [12.34, "Settled 64"],
      [45.67, "Settled 2048"],
      [89.01, "Settled 4096"],
    ]);
  });

  test("a failed pricing request or an indefinitely busy page cannot yield a price", async () => {
    await expect(
      read(
        product(
          storage,
          `
      document.querySelector('button').addEventListener('click', () => fetch('/missing').catch(() => {}));
    `,
        ),
      ),
    ).rejects.toThrow("Required browser request returned HTTP 404");
    await expect(
      Effect.runPromise(
        createProductReader({
          canonical: (raw) => (raw === url ? raw : undefined),
          // Keep the deliberate settling failure short; normal reads allow cold startup.
          timeoutMs: 4_000,
        }).pipe(
          Effect.flatMap((readProduct) =>
            readProduct(
              product(
                "",
                `document.querySelector('.product-wrapper').setAttribute('aria-busy','true')`,
              ),
              url,
            ),
          ),
          Effect.scoped,
        ),
      ),
    ).rejects.toThrow("Product did not settle");
  });

  test("requires a real applied selection instead of assuming the click worked", async () => {
    await expect(read(product(storage))).rejects.toThrow(
      "Storage selection was not applied",
    );
  });

  test("unknown controls and changing option dependencies fail explicitly", async () => {
    await expect(
      read(
        product(
          '<select aria-label="warranty"><option>2 years</option></select>',
        ),
      ),
    ).rejects.toThrow("Unknown selectable option");
    await expect(
      read(
        product(
          storage + colors,
          switches +
            `
      document.querySelector('select').addEventListener('change', () => {
        document.querySelector('button[value="4096"]').disabled = true;
      });
    `,
        ),
      ),
    ).rejects.toThrow("unsupported option dependency");
  });

  test("page script errors and escaped navigation never become a successful catalog", async () => {
    await expect(
      read(product("", "throw new Error('fixture script failed')")),
    ).rejects.toThrow("Page script failed");
    await expect(
      read(
        product(
          storage,
          `
      document.querySelector('button').addEventListener('click', () => location.href = 'https://outside.invalid/');
    `,
        ),
      ),
    ).rejects.toThrow();
  });

  test("cancellation closes the view and a later extraction can still succeed", async () => {
    const controller = new AbortController();
    const pending = read(
      product(
        "",
        "document.querySelector('.product-wrapper').setAttribute('aria-busy','true')",
      ),
      controller.signal,
    );
    const timer = setTimeout(() => controller.abort(), 600);

    try {
      await expect(pending).rejects.toThrow();
      expect((await read(product())).total).toBe(10.11);
    } finally {
      clearTimeout(timer);
    }
  });
});
