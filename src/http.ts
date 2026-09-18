import { Data, Duration, Effect, Exit, Schedule } from "effect";

export class HTTP extends Data.TaggedError("HTTP")<{
  readonly status: number;
  readonly retryAfterMs: number;
  readonly message: string;
}> {}

export class Transport extends Data.TaggedError("Transport")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RequestTimeout extends Data.TaggedError("RequestTimeout")<{
  readonly timeoutMs: number;
  readonly message: string;
}> {}

export class InvalidResponse extends Data.TaggedError("InvalidResponse")<{
  readonly message: string;
}> {}

export type RequestError = HTTP | Transport | RequestTimeout | InvalidResponse;

export class RequestFailure extends Data.TaggedError("RequestFailure")<{
  readonly url: string;
  readonly attempts: number;
  readonly cause: RequestError;
  readonly message: string;
}> {}

export interface RequestOptions {
  canonical: (raw: string, relativeTo: string) => string | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs: number;
  retries: number;
  retryDelayMs: number;
  onRetry?: (delayMs: number) => void;
}

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const MAX_BYTES = 2 * 1024 * 1024;
const invalid = (message: string) => new InvalidResponse({ message });

function retryAfter(value: string | null): number {
  if (!value) return 0;

  if (/^\d+(?:\.\d+)?$/.test(value))
    return Math.min(Number(value) * 1000, 2_147_483_647);

  const date = Date.parse(value);

  return Number.isFinite(date)
    ? Math.min(Math.max(0, date - Date.now()), 2_147_483_647)
    : 0;
}

// Rejected native fetch/read promises are transport failures. Synchronous
// exceptions from the injected fetch adapter remain defects.
const transport = (cause: unknown) =>
  new Transport({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const retryable = (error: RequestError): boolean =>
  error._tag === "Transport" ||
  error._tag === "RequestTimeout" ||
  (error._tag === "HTTP" && TRANSIENT.has(error.status));

export function requestHtml(
  url: string,
  options: RequestOptions,
): Effect.Effect<{ html: string; url: string }, RequestFailure> {
  return Effect.suspend(() => {
    let attempts = 0;

    const attempt = Effect.gen(function* () {
      attempts++;

      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Request interrupted"));
      let currentUrl = url;

      for (let redirects = 0; ; redirects++) {
        const page = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* Effect.acquireRelease(
              Effect.callback<Response, Transport>((resume) => {
                let pending: Promise<Response>;

                try {
                  pending = options.fetch(currentUrl, {
                    signal: controller.signal,
                    redirect: "manual",
                    headers: {
                      accept: "text/html",
                      "user-agent": "NatterAssessmentScraper/0.1",
                    },
                  });
                } catch (defect) {
                  abort();
                  resume(Effect.die(defect));

                  return;
                }

                pending.then(
                  (response) => resume(Effect.succeed(response)),
                  (cause) => resume(transport(cause)),
                );

                return Effect.promise(async () => {
                  abort();
                  const response = await pending.catch(() => undefined);

                  if (response?.body && !response.body.locked)
                    await response.body.cancel().catch(() => {});
                });
              }),
              (resource, exit) =>
                Effect.promise(async () => {
                  if (Exit.isFailure(exit)) abort();

                  if (resource.body && !resource.body.locked)
                    await resource.body.cancel().catch(() => {});
                }),
              { interruptible: true },
            );

            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get("location");

              if (!location)
                return yield* invalid("Redirect has no Location header");

              const next = options.canonical(location, currentUrl);

              if (!next)
                return yield* invalid(
                  `Redirect leaves allowed catalog scope: ${location}`,
                );

              if (redirects >= 5)
                return yield* invalid("Too many redirects (maximum 5)");

              return { redirect: next };
            }

            if (!response.ok)
              return yield* new HTTP({
                status: response.status,
                retryAfterMs: retryAfter(response.headers.get("retry-after")),
                message: `HTTP ${response.status}; check source availability`,
              });

            const contentType = response.headers.get("content-type");

            if (
              contentType &&
              !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(
                contentType,
              )
            )
              return yield* invalid(
                `Expected HTML but received ${contentType}`,
              );

            if (Number(response.headers.get("content-length")) > MAX_BYTES)
              return yield* invalid(`HTML exceeds ${MAX_BYTES} byte limit`);

            const body = response.body;

            if (!body) return yield* invalid("Empty response body");

            const reader = yield* Effect.acquireRelease(
              Effect.sync(() => body.getReader()),
              (resource, exit) =>
                Effect.promise(async () => {
                  // Abort network work before awaiting the reader's cancellation.
                  if (Exit.isFailure(exit)) abort();

                  await resource.cancel().catch(() => {});
                  resource.releaseLock();
                }),
            );

            let html = "";
            let bytes = 0;
            const decoder = new TextDecoder();

            while (true) {
              const chunk = yield* Effect.tryPromise({
                try: () => reader.read(),
                catch: transport,
              });

              if (chunk.done) break;

              bytes += chunk.value.byteLength;

              if (bytes > MAX_BYTES)
                return yield* invalid(`HTML exceeds ${MAX_BYTES} byte limit`);

              html += decoder.decode(chunk.value, { stream: true });
            }

            html += decoder.decode();

            if (!html.trim()) return yield* invalid("Empty HTML response");

            return { html, url: currentUrl };
          }),
        );

        if ("redirect" in page) {
          currentUrl = page.redirect;
        } else return page;
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.requestTimeoutMs,
        orElse: () =>
          new RequestTimeout({
            timeoutMs: options.requestTimeoutMs,
            message: `Request timed out after ${options.requestTimeoutMs}ms`,
          }),
      }),
    );

    const backoff: Schedule.Schedule<Duration.Duration, RequestError> =
      Schedule.exponential(options.retryDelayMs);
    const policy = backoff.pipe(
      Schedule.while(
        ({ input, attempt }) => attempt <= options.retries && retryable(input),
      ),
      Schedule.modifyDelay(({ input, duration }) =>
        Effect.sync(() => {
          const delayMs = Math.max(
            Duration.toMillis(duration),
            input._tag === "HTTP" ? input.retryAfterMs : 0,
          );

          options.onRetry?.(delayMs);

          return delayMs;
        }),
      ),
    );

    return Effect.retry(attempt, policy).pipe(
      Effect.mapError(
        (cause) =>
          new RequestFailure({
            url,
            attempts,
            cause,
            message: `Failed ${url} after ${attempts} attempt(s): ${cause.message}`,
          }),
      ),
    );
  });
}
