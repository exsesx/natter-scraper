# Natter scraper

A TypeScript CLI for the [Web Scraper static e-commerce catalog](https://webscraper.io/test-sites/e-commerce/static). It follows categories and pagination, reads product details, and exports every reachable product and enabled storage configuration as JSON, CSV, or TSV. JSON is the default assessment output. The CLI targets this catalog and has no URL option.

The [assessment implementation note](#implementation-note-for-the-assessment) explains the move from HTTP and copied pricing formulas to browser-observed prices.

## Run

Use Bun **1.4.2**, pinned in `.bun-version`, `mise.toml`, and `package.json`.

Scraping and browser integration tests also require an installed Chrome, Chromium, Edge, or Brave. The scraper uses Bun's experimental [WebView API](https://bun.com/docs/runtime/webview) with the Chrome backend on every platform. Bun finds standard installations; set `BUN_CHROME_PATH` to an absolute executable path when needed. Each run launches a separate headless browser and never attaches to your open browser.

From the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run help

bun run scrape                              # Scrape, then browse
bun run scrape -o products.json              # Save compact JSON and exit
bun run scrape -o products.json --pretty     # Save indented JSON and exit
bun run scrape -o products.csv -i            # Save CSV, then browse
bun run scrape --concurrency 4 -o products.json # Check four products concurrently
```

mise is optional. Review `mise.toml`, run `mise trust` and `mise install`, then prefix commands with `mise exec --` to select the pinned runtime.

`--concurrency N` sets the maximum active product checks and discovery document requests. It defaults to 2 and accepts a positive integer. Browser scripts, styles, and pricing requests can exceed that request count. Higher values overlap the observation waits but use more memory and increase source traffic; the [performance experiments](docs/source-behavior.md#concurrency-and-correctness-experiments) describe the measured tradeoffs.

[Standalone executables](https://github.com/exsesx/natter-scraper/releases) need no Bun or Node.js installation. See [distribution](docs/distribution.md) for platforms and setup; `bun run build` creates a native executable in `dist/`.

### Output selection

| Invocation | Behavior |
| --- | --- |
| No `--output` | Browse in an eligible terminal; otherwise export to stdout |
| `-o FILE` | Save and exit; stdout stays empty |
| `-o FILE -i` | Save, then browse if the terminal is eligible |
| `--output -` | Export to stdout and exit, even with `-i` |
| `--no-interactive` | Export to the requested file or stdout and exit |

`--format auto` infers `.json`, `.csv`, or `.tsv` from the final filename extension, case-insensitively. Unknown or missing extensions fail before scraping. No filename, or `--output -`, selects JSON. An explicit `--format json`, `csv`, or `tsv` overrides any filename extension.

JSON exports default to compact; the browser defaults to pretty. `--pretty` selects two-space indentation and is rejected for CSV/TSV. `--no-pretty` selects compact JSON and leaves CSV/TSV unchanged.

Pipelines disable the browser automatically. Only export data goes to stdout; progress and errors go to stderr. Install `jq` or `less` for these examples:

```sh
bun run scrape | jq '.total'
bun run scrape --pretty | less
bun run scrape --format tsv > products.tsv
```

Shell redirection cannot supply a filename to format inference, so `> products.csv` alone still writes JSON. Prefer `-o products.csv`: file output replaces the destination only after writing the complete export to a temporary file in the same directory. The parent directory must exist. CLI file output replaces existing files without confirmation.

A failed crawl emits no partial catalog. A broken pipe can leave bytes already written and exits with code `1`, including when a pager closes early. Exit codes are `0` for success/help, `1` for scrape/write failure, `2` for invalid usage, `130` for Ctrl+C, and `143` for SIGTERM on macOS/Linux.

## Browse in a terminal

The full-screen browser shows every result in a table, selected product details, and the whole catalog's JSON. It does not dump the export first or save automatically. Closing restores the previous screen and prints a summary with the last saved path or "No file saved." Search and sorting are not included.

Interaction requires stdin, stdout, and stderr to be TTYs, inactive CI, and a terminal other than `TERM=dumb`. Pipes, redirected streams, active CI, and `--output -` override `-i`. A nonempty `CI` value activates CI mode unless it is `0` or `false`, case-insensitively. Below 40 columns by 16 rows, the browser asks you to resize and allows closing or cancellation only.

| Key | Action |
| --- | --- |
| Up / Down | Select a row or scroll JSON, details, or help |
| `d` / `u`, Ctrl+D / Ctrl+U | Move half a visible page down / up |
| Space / `b`, Page Down / Page Up | Move a full visible page down / up |
| `g` / `G`, Home / End | Jump to the beginning / end |
| Tab | Switch Table / JSON |
| Enter | Expand selected product details |
| `[` / `]` | Select the previous / next product in expanded details |
| `r` in JSON | Toggle pretty / compact for the preview and future JSON exports |
| `c`; `j` / `v` / `t` | Choose a copy format; directly copy JSON / CSV / TSV |
| `s` | Save to a file |
| `p` / `o` / `f` | Copy the last saved path / open its folder / open the file in its default app |
| `?` | Open or close help |
| Esc | Go back from JSON, details, help, or a dialog |
| `q`; Ctrl+C | Close the browser; cancel with exit code 130 |

Views remember their position. Selecting another product resets details scrolling; changing JSON formatting resets its preview. Copy and Save always export the entire catalog without fetching again. File actions use the latest successful save and never launch automatically.

### Save dialog

Enter a path, then press Enter. Tab cycles Auto, CSV, TSV, JSON compact, and JSON pretty; Shift+Tab reverses. Auto infers the extension and uses the dialog's displayed JSON style. Explicit choices override the extension. Arrow keys, Home/End, and Backspace/Delete edit the path; Ctrl+U clears it. Shortcut letters are ordinary text while editing. `-` is not a file destination here.

Existing files require confirmation: Enter replaces; Esc returns to the editable path. Other save errors keep the dialog available for correction. A successful JSON save updates the preview and future copies/saves to its chosen style. Cancellation or failure preserves the previous setting. Changing a setting never rewrites an already-saved file.

## Output

This example comes from the captured [Nokia fixture](tests/fixtures/source/product-1.html), not a full live crawl. [output.schema.json](output.schema.json) defines the JSON shape.

```json
{
  "results": [
    {
      "name": "Nokia 123",
      "description": "7 day battery",
      "price": 24.99,
      "colors": ["Black", "Gold", "White"]
    }
  ],
  "total": 24.99
}
```

- Each enabled storage choice produces a result such as `Packard 255 G2 (128 GB)`, even when only one is enabled. Disabled choices and an additional base result are excluded.
- Prices come from the rendered page after selecting each storage choice and its available colors. New capacity values and equal-price configurations need no price-table changes.
- Descriptions preserve source text apart from HTML decoding and whitespace normalization. `colors` appears only for at least two distinct selectable colors; colors do not multiply rows.
- Colors are grouped only when their observed prices and descriptions agree. A difference fails the crawl because the current output contract has one price and description per storage configuration.
- Identity combines the canonical product identity and storage choice, independently of names or prices. Identical duplicates collapse; conflicts fail. Different products with equal prices both count toward the total.
- Prices and totals use checked integer cents before conversion to JSON numbers. Tiny floating-point display errors such as `$517.1700000000001` normalize to cents; other unsupported precision or amounts that lose cent precision fail. Results have deterministic order; JSON numbers need not retain trailing zeros.

CSV/TSV have `name`, `description`, `price`, and `colors` columns. Each result is one row; prices have two decimal places and colors share a `; `-separated cell. They omit a total row; the summary still reports the total. Use JSON for nested colors and a total in one document.

Delimited exports use UTF-8 without a BOM, CRLF records, quoted cells for delimiters/line breaks, and doubled embedded quotes. TSV follows the same rules with tabs. Formula-like text prefixes receive a leading apostrophe; prices remain numeric. This reduces spreadsheet formula risk but does not guarantee safety across applications or save/reopen operations. JSON preserves the original text. See [CSV quoting](https://www.rfc-editor.org/rfc/rfc4180) and [formula handling](https://owasp.org/www-community/attacks/CSV_Injection).

## Develop and verify

### Implementation note for the assessment

The first implementation fetched HTML over HTTP and calculated configuration prices using a formula copied from the site's JavaScript. It was fast, but the calculated prices were predictions based on that implementation, not observations of the selected configurations. A pricing change, a new option, or a price supplied dynamically by a server could make the scraper's results stale without an obvious failure.

The current implementation keeps HTTP for discovery and document fetching, then renders each product in a browser, selects every enabled storage/color combination, and reads the resulting price. It executes the site's own behavior without copying its pricing rules. This costs time, so the performance work keeps product slots occupied and reuses browser views while retaining observation and validation. It is still a site-specific adapter: navigation, control shapes, and completion signals need maintenance when the site changes. [Source evidence and measurements](docs/source-behavior.md) describe what has actually been verified.

### Checks

```sh
bun run check           # Type checking, linting, and tests
bun run test:terminal   # Source CLI in a real terminal session
bun run test:binary     # Compiled application, including terminal cases
bun run benchmark      # Local browser fixtures at concurrency 2, 4, 6, and 8
```

Individual commands are `test`, `typecheck`, `lint`, and `format`. Tests use captured HTML, synthetic cases, and loopback HTTP servers; they do not crawl the public catalog. Integration tests launch a headless browser and exercise the actual option controls, including delayed responses and changed prices. Desktop actions are mocked and do not change the clipboard or open desktop windows. No Python is required. Formatting targets source, tests, scripts, workflows, and project configuration; it excludes captured HTML and exported data files.

The benchmark uses the production reader on 12 synthetic products with independently specified prices, including equal-price storage choices and colors. It warms up the browser, measures each concurrency twice in opposite orders, and checks identical output on every run. JSON measurements go to stdout and progress goes to stderr. It makes only loopback requests and requires the same browser installation as scraping.

[CI](.github/workflows/check.yml) runs these checks and builds native artifacts for macOS, Linux, and Windows on x64 and arm64. Check [workflow results](https://github.com/exsesx/natter-scraper/actions/workflows/check.yml) for a specific commit. Cross-compilation alone does not establish native behavior; [platform verification](docs/distribution.md#verify-on-the-target-platform) records the test boundaries.

The toolchain pins Bun **1.4.2** and TypeScript **7.0.2**. Effect and `@effect/platform-bun` use **4.0.0-rc.115**; keep them aligned. Effect v4 is a release candidate and its `effect/unstable/cli` API is explicitly unstable. Exact dependency versions are in [package.json](package.json) and `bun.lock`.

For review, start with [CLI contract tests](tests/cli.test.ts), [browser observations](src/product-browser.ts), [HTML extraction](src/site.ts), and [catalog construction](src/catalog.ts).

| Guide | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) and [diagram](ARCHITECTURE.md) | Module responsibilities, output flow, adding formats and destinations |
| [Effect walkthrough](docs/effect.md) | Sequencing, typed failures, retries, and cleanup |
| [Source evidence](docs/source-behavior.md) | Dated pricing and discovery observations; read before changing extraction |
| [Distribution](docs/distribution.md) | Executables, desktop helpers, platform checks |
| [AGENTS.md](AGENTS.md) | Shared contributor instructions and Git conventions |
| [Verification guide](.agents/skills/verify-scraper/SKILL.md) | Checks to select for a change; readable without an agent |

No agent application or plugin is required. Agents can select the bundled skill for relevant tasks; in Codex, request it with `$verify-scraper verify my CSV changes`. It runs during an agent task, not automatically on file saves or commits.

## Assumptions and limits

Coverage is limited to pages reachable through the catalog's category, pagination, and product links. Document requests and redirects stay within its origin and subtree. Defaults are two concurrent products/HTTP requests, a 15-second request or browser-operation timeout, a ten-minute crawl deadline, up to two retries for transient HTTP failures, 2 MiB of HTML per document, and 10,000 discovered URLs. A free product slot starts the next queued product immediately. Browser views are reused within the crawl with Chrome's back/forward cache disabled. Before reuse, the reader navigates to a blank document, disables interception and browser event streams, and removes listeners. A temporary hook clears session storage and the window name before the next product's scripts run; it is removed before storage-choice reloads. Views close on completion, failure, or cancellation. Deadline errors report the crawl phase and completed-product count. Browser scripts, styles, and pricing requests may load elsewhere on the same origin; third-party resources, images, fonts, and subframes are blocked. Browser resource loads do not use the HTTP adapter's retry or body-size policy.

The adapter discovers one HDD button group and one color select, with up to 1,000 option selections per product. It checks each enabled storage/color combination and reads the displayed price; it contains no copied pricing formula. Storage may change available colors. Dependencies that change storage choices, colors that change the option sets, and other controls fail explicitly. Supporting new kinds of controls or layouts still requires adapter changes.

Each observation waits for 500 ms of stable product markup and idle tracked network requests, with no `aria-busy` marker. This handles the observed site and tested asynchronous updates, but cannot prove that an arbitrary later timer will never change the page. Missing fields, unsupported currency/precision, script or required-request errors, conflicting identities, and empty results fail. Dated fixtures and bounded live checks are evidence, not a guarantee of future behavior.

Linux executables target glibc, not musl. Desktop actions require [platform helpers](docs/distribution.md#desktop-actions); mocked tests do not verify actual clipboard or launcher integration. Windows force termination cannot provide graceful cleanup, and full Windows console-mode restoration is unverified. Cancellation cannot undo an action already handed to a desktop helper; a force-killed process cannot run cleanup.

AI agents assisted with implementation, tests, source inspection, and documentation. The repository contains no private recruitment correspondence.
