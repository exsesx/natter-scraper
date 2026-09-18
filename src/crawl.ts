import { Data, Effect } from "effect";
import { buildCatalog, type CatalogError } from "./catalog.js";
import { type RequestFailure, requestHtml } from "./http.js";
import { createProductReader, type ProductReader } from "./product-browser.js";
import { type ExtractionError, parseListing } from "./site.js";
import type { Catalog, Progress, SourceProduct } from "./types.js";

export const TARGET_URL = "https://webscraper.io/test-sites/e-commerce/static";

export type FetchFunction = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface CrawlOptions {
  onProgress?: (progress: Progress) => void;
  /** Internal test seam; intentionally absent from the CLI. */
  baseUrl?: string;
  fetch?: FetchFunction;
  /** Internal test seam for transport/CLI tests; production always uses a browser. */
  readProduct?: ProductReader;
  concurrency?: number;
  requestTimeoutMs?: number;
  runTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  maxPages?: number;
}

export interface CrawlResult {
  catalog: Catalog;
  productCount: number;
  pages: number;
}

export class CrawlFailure extends Data.TaggedError("CrawlFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CrawlError =
  | CrawlFailure
  | RequestFailure
  | ExtractionError
  | CatalogError;

export function crawl(
  options: CrawlOptions = {},
): Effect.Effect<CrawlResult, CrawlError> {
  return Effect.gen(function* () {
    const concurrency = options.concurrency ?? 2;
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    const runTimeoutMs = options.runTimeoutMs ?? 600_000;
    const retries = options.retries ?? 2;
    const retryDelayMs = options.retryDelayMs ?? 500;
    const maxPages = options.maxPages ?? 10_000;

    for (const [name, value] of Object.entries({
      concurrency,
      requestTimeoutMs,
      runTimeoutMs,
      maxPages,
    })) {
      if (!Number.isSafeInteger(value) || value < 1)
        return yield* new CrawlFailure({
          message: `${name} must be a positive integer`,
        });
    }

    for (const [name, value] of Object.entries({ retries, retryDelayMs })) {
      if (!Number.isSafeInteger(value) || value < 0)
        return yield* new CrawlFailure({
          message: `${name} must be a nonnegative integer`,
        });
    }

    const base = yield* Effect.try({
      try: () => new URL(options.baseUrl ?? TARGET_URL),
      catch: (cause) =>
        new CrawlFailure({ message: "Invalid crawl base URL", cause }),
    });

    if (!/^https?:$/.test(base.protocol) || base.username || base.password)
      return yield* new CrawlFailure({ message: "Invalid crawl base URL" });

    const rootPath = base.pathname.replace(/\/$/, "");

    function canonical(raw: string, relativeTo: string): string | undefined {
      let url: URL;

      try {
        url = new URL(raw, relativeTo);
      } catch {
        return undefined;
      }

      if (
        url.origin !== base.origin ||
        url.username ||
        url.password ||
        (url.pathname !== rootPath && !url.pathname.startsWith(`${rootPath}/`))
      )
        return undefined;

      // Encoded separators/dot segments must not bypass the subtree check downstream.
      if (/%(?:2f|5c|2e)/i.test(url.pathname)) return undefined;

      url.hash = "";
      url.searchParams.sort();

      return url.href;
    }

    const start = canonical(base.href, base.href);

    if (!start)
      return yield* new CrawlFailure({ message: "Invalid crawl base scope" });

    const progress: Progress = {
      phase: "discovering",
      pages: 0,
      discoveredProducts: 0,
      processedProducts: 0,
      queued: 0,
      active: 0,
      retries: 0,
    };
    const emit = () => options.onProgress?.({ ...progress });

    const request = (url: string) =>
      requestHtml(url, {
        fetch: options.fetch ?? ((input, init) => fetch(input, init)),
        canonical,
        requestTimeoutMs,
        retries,
        retryDelayMs,
        onRetry: () => {
          progress.retries++;
          emit();
        },
      });

    const listings = [start];
    const seen = new Set([start]);
    const productUrls = new Set<string>();
    const products: SourceProduct[] = [];

    const discover = (raw: string, from: string, product: boolean) =>
      Effect.gen(function* () {
        const url = canonical(raw, from);

        if (!url) return;

        if (product) productUrls.add(url);

        if (!seen.has(url)) {
          if (seen.size >= maxPages)
            return yield* new CrawlFailure({
              message: `Catalog exceeds ${maxPages} page limit; no partial results were produced`,
            });

          seen.add(url);

          if (!product) listings.push(url);
        }

        progress.discoveredProducts = productUrls.size;
      });

    const visitAll = <E>(
      urls: string[],
      consume: (html: string, url: string) => Effect.Effect<void, E>,
    ) =>
      Effect.forEach(
        urls,
        (url) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              if (progress.phase === "scraping") progress.queued--;

              progress.active++;
              emit();
            });

            const page = yield* request(url);
            yield* consume(page.html, page.url);
            progress.pages++;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                progress.active--;
                emit();
              }),
            ),
          ),
        { concurrency, discard: true },
      );

    const run = Effect.gen(function* () {
      while (listings.length) {
        const urls = listings.splice(0, concurrency);
        progress.queued = listings.length;

        yield* visitAll(urls, (html, url) =>
          Effect.gen(function* () {
            const found = yield* parseListing(html, url);

            for (const link of found.productLinks)
              yield* discover(link, url, true);

            for (const link of found.links) yield* discover(link, url, false);

            progress.queued = listings.length;
          }),
        );
      }

      if (!productUrls.size)
        return yield* new CrawlFailure({
          message: `No products discovered at ${start}; source markup may have changed`,
        });

      progress.phase = "scraping";
      const pending = [...productUrls].sort();
      const readProduct =
        options.readProduct ??
        (yield* createProductReader({
          canonical,
          timeoutMs: requestTimeoutMs,
        }));

      progress.queued = pending.length;

      yield* visitAll(pending, (html, url) =>
        Effect.gen(function* () {
          products.push(yield* readProduct(html, url));
          progress.processedProducts++;
        }),
      );

      const catalog = yield* buildCatalog(products);

      return {
        catalog,
        productCount: new Set(products.map((product) => product.id)).size,
        pages: progress.pages,
      };
    });

    return yield* run.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: runTimeoutMs,
        orElse: () =>
          new CrawlFailure({
            message: `Crawl deadline exceeded after ${runTimeoutMs}ms while ${progress.phase}: ${progress.processedProducts}/${progress.discoveredProducts} products completed; no partial results were produced`,
          }),
      }),
    );
  });
}
