# Architecture

Open [ARCHITECTURE.md](../ARCHITECTURE.md) for the canonical Mermaid data-flow diagram. The README's separate state diagram describes the CLI experience.

| Module | Responsibility |
| --- | --- |
| [cli.ts](../src/cli.ts) | Define flags with `effect/unstable/cli`, provide Bun platform services, choose terminal mode, and map application outcomes and signals to exit codes. |
| [crawl.ts](../src/crawl.ts) | Discover scoped category/pagination/product links, run bounded batches with `Effect.forEach`, and enforce the whole-crawl deadline. |
| [http.ts](../src/http.ts) | Wrap native `fetch` in request scopes, validate redirects and HTML, bound response size, retry eligible failures, and release response bodies on interruption. |
| [site.ts](../src/site.ts) | Parse HTML into source identities, fields, enabled configurations, and colors. Apply the documented storage price rule. |
| [catalog.ts](../src/catalog.ts) | Validate money, expand storage results, reject identity conflicts, order results, and sum integer cents. |
| [format.ts](../src/format.ts) | Serialize the validated catalog as JSON, CSV, or TSV, including delimited-cell escaping. |
| [output.ts](../src/output.ts) | Await stdout writes or close a temporary sibling file before atomically renaming it into place; remove owned temporary files on exit. |
| [ui.tsx](../src/ui.tsx) | Render progress and completion actions on stderr and restore terminal state on exit. |
| [desktop.ts](../src/desktop.ts) | Copy text or open the saved file's folder through replaceable adapters. |
| [types.ts](../src/types.ts) | Share source, result, and progress types across these boundaries. |

The crawler completes discovery before fetching product details. It builds the catalog only after every required product succeeds. Parsing and catalog validation return Effects with typed failures. Serialization is a pure function that returns a string; it performs no I/O and needs no Effect runtime. Expected failures carry tagged types such as `ExtractionError`, `CatalogError`, and `RequestFailure`; unexpected programmer exceptions remain defects.

Each request attempt has an abort controller. Response and body-reader scopes close each redirect response before the next request, and the pending-fetch adapter awaits cancellation cleanup. Retry schedules apply only to eligible request failures, after cleanup of the previous attempt. A failed batch interrupts its other requests; request and crawl deadlines use the same cleanup path. Output happens after catalog validation, so a source or data failure cannot publish a partial success. File output uses a temporary sibling and rename; stdout cannot roll back bytes after a write failure.

The CLI loads the terminal module only when all three streams are TTYs, CI is inactive, and interaction is enabled. Help goes to stdout when explicitly requested; usage errors and their help go to stderr. The parser and catalog know nothing about terminal keys or desktop helpers. The default copy action reuses the exact exported text. Alternate-format copy actions serialize the retained validated catalog, without another crawl or file write. Desktop promise adapters report `DesktopError`; interruption cannot undo an external action already started.

The same CLI entry point runs from source and in a standalone executable. The build embeds Bun, application dependencies, and Ink's Yoga WebAssembly asset. It disables automatic environment-file and Bun-configuration loading and excludes optional React development tools. The compiled application keeps the same extraction, output, and terminal behavior; packaging adds no alternative crawl path.

[The Effect walkthrough](effect.md) follows failure and cleanup through the code. [Source evidence](source-behavior.md) explains the pricing adapter. [Distribution](distribution.md) describes executable targets, desktop requirements, and platform verification. The [README](../README.md#develop-and-verify) provides the source-development commands.
