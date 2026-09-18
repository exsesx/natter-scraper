import { Effect } from "effect";
import { ExtractionError, type ProductSnapshot, parseProduct } from "./site";
import type { SourceProduct, SourceVariant } from "./types";

export type ProductReader = (
  html: string,
  url: string,
) => Effect.Effect<SourceProduct, ExtractionError>;

interface BrowserOptions {
  canonical: (raw: string, relativeTo: string) => string | undefined;
  timeoutMs: number;
}

interface PageState {
  productCount: number;
  html: string;
  busy: boolean;
  color: string | null;
  url: string;
}

interface PausedRequest {
  requestId: string;
  frameId: string;
  resourceType: string;
  request: { url: string };
}

const wrapper = ".test-site .product-wrapper";
const storageSelector = `${wrapper} .swatches button`;
const colorSelector = `${wrapper} select[aria-label="color" i]`;
const quietMs = 500;
const maxSelections = 1_000;
const resourceTypes = new Set([
  "Document",
  "Script",
  "Stylesheet",
  "XHR",
  "Fetch",
]);

function sameChoices(left: ProductSnapshot, right: ProductSnapshot) {
  return JSON.stringify(left.storage) === JSON.stringify(right.storage);
}

/** Read prices after interaction; no site pricing source code or formula is copied. */
export function createProductReader(options: BrowserOptions) {
  return Effect.gen(function* () {
    const idle: Bun.WebView[] = [];
    const views = new Set<Bun.WebView>();
    let closed = false;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;

        for (const view of views) view.close();

        views.clear();
        idle.length = 0;
      }),
    );

    const read: ProductReader = (html, url) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (closed) throw new Error("Product reader scope is closed");

          const available = idle.pop();
          // Spawn a dedicated headless browser. Never attach to the user's open browser.
          const view =
            available ??
            new Bun.WebView({
              backend: {
                type: "chrome",
                url: false,
                // Completed documents need no back navigation. Avoid retaining
                // their renderer heaps while this tab moves through the catalog.
                argv: ["--disable-features=BackForwardCache"],
              },
              dataStore: "ephemeral",
              width: 1280,
              height: 900,
            });
          views.add(view);

          const listeners: Array<[string, EventListener]> = [];
          let reusable = false;
          const abort = () => view.close();
          signal.addEventListener("abort", abort, { once: true });

          if (signal.aborted) abort();

          try {
            const bounded = async <A>(
              name: string,
              operation: () => Promise<A>,
            ): Promise<A> => {
              let timedOut = false;
              const timer = setTimeout(() => {
                timedOut = true;
                view.close();
              }, options.timeoutMs);

              try {
                return await operation();
              } catch (cause) {
                if (timedOut)
                  throw new Error(
                    `Browser operation timed out after ${options.timeoutMs}ms during ${name}`,
                  );

                throw cause;
              } finally {
                clearTimeout(timer);
              }
            };

            if (!available)
              await bounded("initial browser navigation", () =>
                view.navigate("about:blank"),
              );

            // WebView permits one CDP call at a time. Network handlers share this queue.
            let commands: Promise<unknown> = Promise.resolve();
            const cdp = (
              method: string,
              params: Record<string, unknown> = {},
            ) => {
              const result = commands.then(() =>
                bounded(`CDP ${method}`, () => view.cdp(method, params)),
              );
              commands = result.catch(() => {});

              return result;
            };
            const origin = new URL(url).origin;
            const { frameTree } = (await cdp("Page.getFrameTree")) as {
              frameTree: { frame: { id: string } };
            };
            const pending = new Set<string>();
            let observedCurrency: "USD" | undefined;
            let networkChanged = Date.now();
            let problem: Error | undefined;
            const fail = (message: string) => {
              problem ??= new Error(message);
            };
            const event = <A>(name: string, receive: (data: A) => void) => {
              const listener: EventListener = (value) =>
                receive((value as Event & { data: A }).data);
              listeners.push([name, listener]);
              view.addEventListener(name, listener);
            };

            event<PausedRequest>("Fetch.requestPaused", (request) => {
              const target = new URL(request.request.url);
              let command: Promise<unknown>;

              if (
                request.resourceType === "Document" &&
                request.frameId === frameTree.frame.id
              ) {
                if (
                  !options.canonical(target.href, url) ||
                  target.href !== url
                ) {
                  fail(
                    `Product navigation leaves the expected page: ${target.href}`,
                  );
                  command = cdp("Fetch.failRequest", {
                    requestId: request.requestId,
                    errorReason: "BlockedByClient",
                  });
                } else {
                  // Render the HTTP adapter's bounded, retry-checked document at its real URL.
                  command = cdp("Fetch.fulfillRequest", {
                    requestId: request.requestId,
                    responseCode: 200,
                    responseHeaders: [
                      {
                        name: "Content-Type",
                        value: "text/html; charset=utf-8",
                      },
                    ],
                    body: Buffer.from(html).toString("base64"),
                  });
                }
              } else if (
                target.origin === origin &&
                resourceTypes.has(request.resourceType) &&
                request.resourceType !== "Document"
              ) {
                command = cdp("Fetch.continueRequest", {
                  requestId: request.requestId,
                });
              } else {
                command = cdp("Fetch.failRequest", {
                  requestId: request.requestId,
                  errorReason: "BlockedByClient",
                });
              }

              void command.catch((cause) => fail(String(cause)));
            });
            event<{
              requestId: string;
              type: string;
              request: { url: string };
            }>("Network.requestWillBeSent", (request) => {
              if (
                new URL(request.request.url).origin !== origin ||
                !resourceTypes.has(request.type)
              )
                return;

              pending.add(request.requestId);
              networkChanged = Date.now();
            });
            event<{ requestId: string }>(
              "Network.loadingFinished",
              ({ requestId }) => {
                if (pending.delete(requestId)) networkChanged = Date.now();
              },
            );
            event<{ requestId: string; errorText: string }>(
              "Network.loadingFailed",
              ({ requestId, errorText }) => {
                if (pending.delete(requestId)) {
                  networkChanged = Date.now();
                  fail(`Required browser request failed: ${errorText}`);
                }
              },
            );
            event<{ type: string; response: { status: number; url: string } }>(
              "Network.responseReceived",
              ({ type, response }) => {
                if (resourceTypes.has(type) && response.status >= 400)
                  fail(
                    `Required browser request returned HTTP ${response.status}: ${response.url}`,
                  );
              },
            );
            event<{
              exceptionDetails: {
                text: string;
                exception?: { description?: string };
              };
            }>("Runtime.exceptionThrown", ({ exceptionDetails }) => {
              fail(
                `Page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
              );
            });
            await cdp("Network.enable");
            await cdp("Network.setBypassServiceWorker", { bypass: true });
            await cdp("Runtime.enable");
            await cdp("Fetch.enable", {
              patterns: [{ urlPattern: "*", requestStage: "Request" }],
            });

            const readState = async (): Promise<PageState> =>
              (await bounded("snapshot evaluation", () =>
                view.evaluate(`(() => {
          const elements = document.querySelectorAll(${JSON.stringify(wrapper)});
          const element = elements[0];
          return {
            productCount: elements.length,
            html: element ? '<div class="test-site">' + element.outerHTML + '</div>' : '',
            busy: Boolean(element?.matches('[aria-busy="true"]') || element?.querySelector('[aria-busy="true"]')),
            color: document.querySelector(${JSON.stringify(colorSelector)})?.value ?? null,
            url: location.href,
          };
        })()`),
              )) as PageState;

            const snapshot = async () => {
              const started = Date.now();
              let changed = started;
              let previous = "";

              while (Date.now() - started < options.timeoutMs) {
                if (problem) throw problem;

                const state = await readState();
                const current = JSON.stringify(state);

                if (state.productCount > 1)
                  throw new Error(`Expected one product detail at ${url}`);
                if (state.url !== url)
                  throw new Error("Product left the expected URL");
                if (!state.html || current !== previous || state.busy)
                  changed = Date.now();
                if (
                  state.html &&
                  pending.size === 0 &&
                  Date.now() - Math.max(changed, networkChanged) >= quietMs
                ) {
                  const product = await Effect.runPromise(
                    parseProduct(state.html, url, observedCurrency),
                  );
                  observedCurrency = "USD";

                  return { product, color: state.color };
                }

                previous = current;
                await Bun.sleep(50);
              }

              throw new Error(
                `Product did not settle within ${options.timeoutMs}ms`,
              );
            };
            const reset = async () => {
              observedCurrency = undefined;
              await bounded("product navigation", () => view.navigate(url));

              return (await snapshot()).product;
            };
            const selectStorage = async (key: string) => {
              const selector = (await bounded(
                "storage selector evaluation",
                () =>
                  view.evaluate(
                    `${JSON.stringify(storageSelector)} + '[value="' + CSS.escape(${JSON.stringify(key)}) + '"]'`,
                  ),
              )) as string;
              await bounded("storage scrolling", () =>
                view.scrollTo(selector, { timeout: options.timeoutMs }),
              );
              await bounded("storage selection", () =>
                view.click(selector, { timeout: options.timeoutMs }),
              );
              const observed = (await snapshot()).product;

              if (observed.selectedStorage !== key)
                throw new Error(`Storage selection was not applied: ${key}`);

              return observed;
            };

            // Clear tab state after the previous document's unload handlers, before
            // this product's scripts. Remove the hook before storage-choice reloads.
            const { identifier } = (await cdp(
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source:
                  "if (window === window.top) { sessionStorage.clear(); window.name = ''; }",
              },
            )) as { identifier: string };
            const initial = await reset();
            await cdp("Page.removeScriptToEvaluateOnNewDocument", {
              identifier,
            });

            const choices = initial.storage.length
              ? initial.storage
              : [{ key: "base", label: "" }];
            const variants: SourceVariant[] = [];
            let selections = 0;

            for (const choice of choices) {
              // Even without colors, prior clicks can change hidden script state or
              // accumulate price/description changes. Visible controls cannot reset it.
              const fresh = variants.length ? await reset() : initial;

              if (!sameChoices(initial, fresh))
                throw new Error(
                  "Storage availability changed between observations",
                );

              const selected = initial.storage.length
                ? await selectStorage(choice.key)
                : fresh;

              if (!sameChoices(initial, selected))
                throw new Error(
                  "Storage selection changes other storage choices; unsupported option dependency",
                );

              let observed = selected;
              let colorReference: ProductSnapshot | undefined;
              const colors: string[] = [];

              for (const color of selected.colors) {
                if (++selections > maxSelections)
                  throw new Error(
                    `Product exceeds ${maxSelections} option selections`,
                  );

                // Native <select> has no WebView selectOption API. Apply its DOM selection
                // and dispatch the standard input/change events, then verify rendered output.
                await bounded("color selection", () =>
                  view.evaluate(`(() => {
              const select = document.querySelector(${JSON.stringify(colorSelector)});
              select.value = ${JSON.stringify(color.key)};
              select.dispatchEvent(new Event('input', { bubbles: true }));
              select.dispatchEvent(new Event('change', { bubbles: true }));
            })()`),
                );
                const state = await snapshot();
                observed = state.product;

                if (state.color !== color.key)
                  throw new Error(
                    `Color selection was not applied: ${color.label}`,
                  );
                if (
                  observed.selectedStorage !== selected.selectedStorage ||
                  !sameChoices(selected, observed) ||
                  JSON.stringify(observed.colors) !==
                    JSON.stringify(selected.colors)
                )
                  throw new Error(
                    "Color selection changes available options; unsupported option dependency",
                  );
                if (
                  colorReference &&
                  (observed.priceCents !== colorReference.priceCents ||
                    observed.description !== colorReference.description)
                )
                  throw new Error(
                    "Colors have different prices or descriptions; the output schema cannot group them into one product",
                  );

                colorReference = observed;
                colors.push(color.label);
              }

              if (++selections > maxSelections)
                throw new Error(
                  `Product exceeds ${maxSelections} option selections`,
                );

              variants.push({
                key: choice.key,
                ...(choice.label ? { label: choice.label } : {}),
                name: selected.name,
                description: observed.description,
                priceCents: observed.priceCents,
                colors,
              });
            }

            const product = {
              id: initial.id,
              name: initial.name,
              description: initial.description,
              variants,
              colors: [],
            };

            // End this document and its timers before another product leases the view.
            await bounded("cleanup navigation", () =>
              view.navigate("about:blank"),
            );
            await cdp("Fetch.disable");
            await cdp("Network.disable");
            await cdp("Runtime.disable");

            if (problem) throw problem;

            reusable = true;

            return product;
          } finally {
            signal.removeEventListener("abort", abort);

            for (const [name, listener] of listeners)
              view.removeEventListener(name, listener);

            if (reusable && !signal.aborted && !closed) idle.push(view);
            else {
              view.close();
              views.delete(view);
            }
          }
        },
        catch: (cause) =>
          cause instanceof ExtractionError
            ? cause
            : new ExtractionError({
                url,
                message: `Browser extraction failed at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
      });

    return read;
  });
}
