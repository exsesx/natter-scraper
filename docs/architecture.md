# Architecture

See the [data-flow diagram](../ARCHITECTURE.md) for the overview and the [README](../README.md) for flags, keys, and output defaults.

| Module | Responsibility |
| --- | --- |
| [main.ts](../src/main.ts) | Run the CLI Effect and apply its exit code. Source and standalone builds share this entry point. |
| [cli.ts](../src/cli.ts) | Validate flags, choose browser or direct output, and handle signals and exit codes. |
| [crawl.ts](../src/crawl.ts) | Discover scoped links, keep the available product slots busy at bounded concurrency, and enforce the crawl deadline. |
| [http.ts](../src/http.ts) | Own fetch, redirects, HTML validation, size limits, timeouts, retries, and response cleanup. |
| [product-browser.ts](../src/product-browser.ts) | Render the fetched document in Bun.WebView, select enabled storage/color combinations, wait for updates, and read observed variant fields. |
| [site.ts](../src/site.ts) | Parse listing links and a single rendered product snapshot. Validate supported controls and currency; infer no unselected prices. |
| [catalog.ts](../src/catalog.ts) | Validate identities and money, expand storage results, order them, and sum integer cents. |
| [format.ts](../src/format.ts) | Serialize the catalog as JSON, CSV, or TSV without I/O. |
| [output-format.ts](../src/output-format.ts) | Infer filename extensions and resolve `auto` or return a typed error. |
| [output.ts](../src/output.ts) | Await stdout writes or publish completed files. |
| [ui.tsx](../src/ui.tsx) | Own Ink's terminal lifecycle, progress, screen restoration, and completion summary. |
| [browser.tsx](../src/browser.tsx) | Compose the browser and handle navigation. |
| [browser-actions.ts](../src/browser-actions.ts) | Run copy, save, and desktop Effects; retain the last successful save. |
| [browser-dialogs.tsx](../src/browser-dialogs.tsx) | Handle path editing, format choices, and overwrite confirmation. |
| [browser-views.tsx](../src/browser-views.tsx) | Render the table, details, help, header, and footer. |
| [terminal-text.ts](../src/terminal-text.ts) | Escape and wrap terminal text without altering exports. |
| [desktop.ts](../src/desktop.ts) | Adapt clipboard, open-file, and open-folder operations. |
| [types.ts](../src/types.ts) | Define the shared source, catalog, progress, and completion types. |

## Data and output

Discovery finishes before product fetching starts. Every required product must succeed before `buildCatalog` validates the result. Source or data failures therefore publish no partial catalog. The catalog stays in memory for serialization and browsing.

The HTTP adapter fetches each product document once. The browser adapter intercepts navigation and serves that document at its original URL, then lets same-origin scripts, styles, and pricing requests execute. It resets the page between storage choices, discovers colors after each storage selection, and observes each combination. The pure parser reads each settled snapshot. Variant names, descriptions, colors, and integer-cent prices reach `catalog.ts` without a storage surcharge formula. Color-specific title suffixes remain grouped under the name observed before color selection; differing color prices or descriptions fail.

The headless extraction browser is separate from the Ink terminal browser below. It uses an ephemeral Chrome backend with `BackForwardCache` disabled and never attaches to a user's browser. The product reader owns its views through the crawl's Effect scope. A successful read navigates to a blank document to end scripts and timers, disables interception and Network/Runtime event streams, and removes listeners before returning the view to the pool. Before loading the next product, a temporary new-document hook clears `sessionStorage` and `window.name` after the previous document's unload handlers and before the new product's scripts. The hook is removed after the initial observation, so storage-choice reloads retain that product's tab-local state. Failed or cancelled reads close their views; leaving the crawl scope closes all remaining views. Browser operations and observations have timeouts; the ten-minute crawl deadline includes them and reports incomplete progress on failure. See [source behavior](source-behavior.md) for the supported control shapes and observation limits.

File output writes and closes a temporary sibling before publication:

- Initial CLI output and confirmed browser replacement use atomic rename.
- An unconfirmed browser Save uses `fs.link`, which refuses an existing destination atomically. `EEXIST` opens the replacement dialog, including if another process creates the destination during the save.
- A finalizer removes the owned temporary filename. Stdout writes wait for their callback, but cannot roll back bytes already written.

These are publication guarantees, not crash durability guarantees. The writer does not call `fsync`. See [Effect cleanup](effect.md#failure-and-cleanup) for interruption behavior.

## Browser boundaries

`shouldInteract` requires three TTY streams, inactive CI, a terminal other than `TERM=dumb`, and no explicit `--output -`. Interaction defaults off with `--output`; `-i` enables it when those conditions hold. An initial output file is written before the browser opens.

The browser renders visible rows or lines from the retained catalog. Navigation makes no requests. Copy and Save serialize the whole catalog. A successful JSON save updates the browser's pretty/compact setting; a failed or cancelled save leaves it unchanged. Dialogs own their input, so path text cannot trigger navigation or desktop shortcuts. Below 40 columns or 16 rows, only the resize notice and exit controls remain available.

Browser action failures leave the catalog available for retry. Initial output failures end the run. Closing joins action cleanup, restores the previous screen, and prints a summary. Clipboard and file-opening actions require an explicit keypress. Their adapters load desktop dependencies lazily and accept paths as arguments, never shell command strings.

## Adding a format or destination

Formats and destinations are separate. `serializeCatalog` takes a `Catalog` and returns a string; file, stdout, and clipboard adapters consume that string.

To add a text format:

1. Extend `OutputFormat` in `types.ts` and the exhaustive serializer switch in `format.ts`.
2. Add filename inference in `output-format.ts`, CLI flag choices, and browser dialog choices.
3. Update help and docs. Test exact bytes in [format tests](../tests/format.test.ts), extensions in [format inference tests](../tests/output-format.test.ts), and CLI/browser selection.

JSON pretty/compact is a serializer option, not a separate format. A new destination belongs in an I/O adapter called by `cli.ts` or `browser-actions.ts`. Keep its errors and cancellation in Effect and test it through injection, as saves and desktop actions do.

This is an explicit source extension, not a runtime plugin API. Binary formats such as XLSX need a byte-oriented serializer and writer; streaming needs a different output contract. Neither is implemented by adding a format name, but neither requires changing extraction or pricing.
