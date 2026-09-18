import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
  type CrawlOptions,
  crawl as crawlEffect,
  type FetchFunction,
} from "../src/crawl";
import type { Progress } from "../src/types";

const crawl = (options: CrawlOptions & { signal?: AbortSignal }) => {
  const { signal, ...config } = options;

  return Effect.runPromise(crawlEffect(config), { signal });
};

const baseUrl = "https://fixture.test/catalog";
const listing = (products: string[] = [], links: string[] = []) =>
  `<div class="test-site"><div id="side-menu"></div><div class="pagination">${links.map((link) => `<a href="${link}">Next</a>`).join("")}</div>${products.map((link) => `<a class="title" href="${link}">Product</a>`).join("")}</div>`;
const product = (name: string) =>
  `<div class="test-site"><div class="product-wrapper"><h4 class="price">$1.23<meta itemprop="priceCurrency" content="USD"></h4><h4 class="title">${name}</h4><p class="description">Fixture description</p></div></div>`;
const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html" } });
const basic: FetchFunction = async (url) =>
  html(
    url.includes("/product/")
      ? product("One")
      : listing([`${baseUrl}/product/1`]),
  );

function hanging(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);

    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

describe("bounded catalog traversal", () => {
  test("local HTTP catalog follows pagination, deduplicates canonical links and retains equal-price products", async () => {
    const requests: string[] = [];
    let active = 0;
    let maximum = 0;
    const progress: Progress[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        active++;
        maximum = Math.max(maximum, active);
        await Bun.sleep(5);

        const url = new URL(request.url);

        requests.push(url.pathname + url.search);
        active--;

        if (url.pathname === "/catalog/product/1") return html(product("One"));

        if (url.pathname === "/catalog/product/2") return html(product("Two"));

        if (url.search)
          return html(listing(["/catalog/product/2"], ["/catalog"]));

        return html(
          listing(
            ["/catalog/product/1", "/catalog/product/1#again"],
            [
              "/catalog?b=2&a=1",
              "/catalog?a=1&b=2#again",
              "/catalog-other",
              "https://foreign.test/catalog",
              "/catalog/%2Fescape",
            ],
          ),
        );
      },
    });

    try {
      const result = await crawl({
        baseUrl: `http://127.0.0.1:${server.port}/catalog`,
        onProgress: (value) => progress.push(value),
      });

      expect(result.catalog).toEqual({
        results: [
          { name: "One", description: "Fixture description", price: 1.23 },
          { name: "Two", description: "Fixture description", price: 1.23 },
        ],
        total: 2.46,
      });
      expect(result.productCount).toBe(2);
      expect(result.pages).toBe(4);
      expect(requests.sort()).toEqual(
        [
          "/catalog",
          "/catalog?a=1&b=2",
          "/catalog/product/1",
          "/catalog/product/2",
        ].sort(),
      );
      expect(maximum).toBe(2);
      expect(
        progress
          .filter((value) => value.phase === "scraping")
          .every((value) => value.discoveredProducts === 2),
      ).toBe(true);
      expect(progress.at(-1)?.active).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("retries transient GETs and reports retry progress", async () => {
    let attempts = 0;
    let reportedRetries = 0;

    const result = await crawl({
      baseUrl,
      retryDelayMs: 1,
      onProgress: (value) => {
        reportedRetries = value.retries;
      },
      fetch: async (url, init) => {
        expect(init.redirect).toBe("manual");

        if (++attempts <= 2) return new Response("busy", { status: 503 });

        return basic(url, init);
      },
    });

    expect(result.productCount).toBe(1);
    expect(attempts).toBe(4);
    expect(reportedRetries).toBe(2);
  });

  test("exhaustion and permanent HTTP errors identify URL and status", async () => {
    let calls = 0;

    await expect(
      crawl({
        baseUrl,
        retryDelayMs: 0,
        fetch: async () => {
          calls++;

          return new Response("busy", { status: 429 });
        },
      }),
    ).rejects.toThrow(`Failed ${baseUrl} after 3 attempt(s): HTTP 429`);
    expect(calls).toBe(3);

    calls = 0;

    await expect(
      crawl({
        baseUrl,
        fetch: async () => {
          calls++;

          return new Response("missing", { status: 404 });
        },
      }),
    ).rejects.toThrow("HTTP 404");
    expect(calls).toBe(1);
  });

  test("validates every redirect before making the next request", async () => {
    const calls: string[] = [];

    await expect(
      crawl({
        baseUrl,
        fetch: async (url) => {
          calls.push(url);

          return new Response(null, {
            status: 302,
            headers: {
              location:
                url === baseUrl
                  ? "/catalog/next"
                  : "https://foreign.test/secret",
            },
          });
        },
      }),
    ).rejects.toThrow("Redirect leaves allowed catalog scope");
    expect(calls).toEqual([baseUrl, `${baseUrl}/next`]);

    await expect(
      crawl({
        baseUrl,
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "/catalog-sibling" },
          }),
      }),
    ).rejects.toThrow("scope");
  });

  test("bounds redirect loops", async () => {
    let calls = 0;

    await expect(
      crawl({
        baseUrl,
        fetch: async () => {
          calls++;

          return new Response(null, {
            status: 302,
            headers: { location: baseUrl },
          });
        },
      }),
    ).rejects.toThrow("Too many redirects");
    expect(calls).toBe(6);
  });

  test("fails instead of returning partial data and drains concurrent requests", async () => {
    let active = 0;
    let cancelled = false;

    await expect(
      crawl({
        baseUrl,
        fetch: async (url, init) => {
          if (url === baseUrl)
            return html(
              listing([`${baseUrl}/product/1`, `${baseUrl}/product/2`]),
            );

          if (url.endsWith("/1")) {
            await Bun.sleep(10);

            return new Response("missing", { status: 404 });
          }

          active++;

          try {
            return await hanging(init.signal as AbortSignal);
          } finally {
            active--;
            cancelled = true;
          }
        },
      }),
    ).rejects.toThrow("HTTP 404");
    expect(cancelled).toBe(true);
    expect(active).toBe(0);
  });

  test("request timeout is retryable and whole-run deadline interrupts work", async () => {
    let calls = 0;

    await expect(
      crawl({
        baseUrl,
        requestTimeoutMs: 10,
        retryDelayMs: 0,
        fetch: async (_url, init) => {
          calls++;

          return await hanging(init.signal as AbortSignal);
        },
      }),
    ).rejects.toThrow("Request timed out");
    expect(calls).toBe(3);

    await expect(
      crawl({
        baseUrl,
        requestTimeoutMs: 1000,
        runTimeoutMs: 10,
        fetch: async (_url, init) => hanging(init.signal as AbortSignal),
      }),
    ).rejects.toThrow("Crawl deadline exceeded");
  });

  test("respects Retry-After and permits cancellation during the wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = crawl({
      baseUrl,
      signal: controller.signal,
      retryDelayMs: 0,
      fetch: async () => {
        calls++;

        return new Response("busy", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      },
    });

    await Bun.sleep(20);

    expect(calls).toBe(1);

    controller.abort(new Error("User cancelled"));
    await expect(pending).rejects.toThrow();
  });

  test("deadline cancels a stalled response body", async () => {
    let cancelled = false;

    await expect(
      crawl({
        baseUrl,
        retries: 0,
        requestTimeoutMs: 10,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("<html>"));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/html" } },
          ),
      }),
    ).rejects.toThrow("Request timed out");
    expect(cancelled).toBe(true);
  });

  test("rejects nonHTML, oversized bodies, empty discovery and page-limit exhaustion", async () => {
    await expect(
      crawl({
        baseUrl,
        fetch: async () =>
          new Response("{}", {
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("Expected HTML");
    await expect(
      crawl({
        baseUrl,
        fetch: async () => html("x".repeat(2 * 1024 * 1024 + 1)),
      }),
    ).rejects.toThrow("byte limit");
    await expect(
      crawl({ baseUrl, fetch: async () => html(listing()) }),
    ).rejects.toThrow("No products discovered");
    await expect(crawl({ baseUrl, maxPages: 1, fetch: basic })).rejects.toThrow(
      "page limit",
    );
  });

  test("awaits delayed reader cleanup before reporting timeout", async () => {
    let cleaned = false;
    let stream: ReadableStream<Uint8Array> | undefined;

    await expect(
      crawl({
        baseUrl,
        retries: 0,
        requestTimeoutMs: 10,
        fetch: async () => {
          stream = new ReadableStream<Uint8Array>({
            async cancel() {
              await Bun.sleep(30);
              cleaned = true;
            },
          });

          return new Response(stream, {
            headers: { "content-type": "text/html" },
          });
        },
      }),
    ).rejects.toThrow("Request timed out");
    expect(cleaned).toBe(true);
    expect(stream?.locked).toBe(false);
  });

  test("sibling failure waits for delayed body cancellation", async () => {
    let cleaned = false;

    await expect(
      crawl({
        baseUrl,
        fetch: async (url) => {
          if (url === baseUrl)
            return html(
              listing([`${baseUrl}/product/1`, `${baseUrl}/product/2`]),
            );

          if (url.endsWith("/1")) {
            await Bun.sleep(10);

            return new Response("missing", { status: 404 });
          }

          return new Response(
            new ReadableStream({
              async cancel() {
                await Bun.sleep(30);
                cleaned = true;
              },
            }),
            { headers: { "content-type": "text/html" } },
          );
        },
      }),
    ).rejects.toThrow("HTTP 404");
    expect(cleaned).toBe(true);
  });

  test("preserves programmer defects without retrying them", async () => {
    const defect = new Error("Broken adapter invariant");
    let calls = 0;

    const exit = await Effect.runPromiseExit(
      crawlEffect({
        baseUrl,
        retryDelayMs: 0,
        fetch: () => {
          calls++;
          throw defect;
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }

    expect(calls).toBe(1);
  });

  test("retains transport error causes and attempt context", async () => {
    const cause = new TypeError("Network unavailable");
    const exit = await Effect.runPromiseExit(
      crawlEffect({
        baseUrl,
        retries: 0,
        fetch: async () => {
          throw cause;
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);

      expect(error).toMatchObject({
        _tag: "RequestFailure",
        url: baseUrl,
        attempts: 1,
        cause: { _tag: "Transport", cause },
      });
    }
  });

  test("awaits delayed fetch unwind before reporting timeout", async () => {
    let cleaned = false;

    await expect(
      crawl({
        baseUrl,
        retries: 0,
        requestTimeoutMs: 10,
        fetch: async (_url, init) => {
          try {
            return await hanging(init.signal as AbortSignal);
          } finally {
            await Bun.sleep(30);
            cleaned = true;
          }
        },
      }),
    ).rejects.toThrow("Request timed out");
    expect(cleaned).toBe(true);
  });
});
