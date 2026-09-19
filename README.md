# Natter scraper

A TypeScript CLI for the [Web Scraper static e-commerce catalog](https://webscraper.io/test-sites/e-commerce/static). It follows categories, pagination, and product links, then returns one JSON object containing `results` and `total`. Each result has a name, description, numeric price, and colors only when multiple colors are available. Each enabled HDD configuration gets its own named row. The CLI targets this catalog and has no URL option.

For assessment review, use `bun run scrape --no-interactive` to print the JSON or `bun run scrape -o products.json` to save it. The terminal browser, CSV/TSV exports, reopening saved catalogs, and standalone binaries are optional conveniences. The [implementation note](#implementation-note-for-the-assessment) explains the scope and the move from copied pricing formulas to browser-observed prices.

## Demo

https://github.com/user-attachments/assets/0e20a78d-33aa-46f4-a9b4-102a74258b60

[Download the demo (1 minute 50 seconds)](docs/assets/demo.mp4).

## Run

Supported platforms are macOS and Linux with glibc, on x64 and arm64. Use Bun **1.4.2**, pinned in `.bun-version`, `mise.toml`, and `package.json`.

Scraping and browser integration tests also require an installed Chrome, Chromium, Edge, or Brave. The scraper uses Bun's experimental [WebView API](https://bun.com/docs/runtime/webview) with the Chrome backend on both platforms. Bun finds standard installations; set `BUN_CHROME_PATH` to an absolute executable path when needed. Scraping launches dedicated headless browser processes and never attaches to your open browser.

From the repository root:

```sh
bun install --frozen-lockfile
bun run scrape --no-interactive              # One complete JSON object on stdout
bun run scrape -o products.json              # Save compact JSON and exit
bun run check                               # Type checking, linting, and offline tests
```

Progress and errors go to stderr. In an eligible terminal, plain `bun run scrape` opens the optional browser and does not automatically print or save JSON. Other invocations:

```sh
bun run help
bun run scrape                              # Scrape, then browse
bun run scrape --input products.json         # Browse saved data without scraping
bun run scrape -o products.json --pretty     # Save indented JSON and exit
bun run scrape -o products.csv -i            # Save CSV, then browse
bun run scrape --concurrency 4 -o products.json # Override automatic concurrency
```

mise is optional. Review `mise.toml`, run `mise trust` and `mise install`, then prefix commands with `mise exec --` to select the pinned runtime.

`--concurrency N` sets the maximum active product checks and discovery document requests. Without an override, startup selects `max(1, min(6, available CPUs, floor(total RAM / 2 GiB)))`. Available CPUs means the runtime's `availableParallelism()` estimate, not a physical-core count. This gives 6 slots with 10 available CPUs and 16 GiB RAM, 4 with 4 CPUs and 8 GiB, and 2 with either 2 CPUs and 4 GiB or 32 CPUs and 4 GiB.

The cap of six comes from the measured speed/memory tradeoff. The 2 GiB per slot is a sizing heuristic based on total RAM, not a measured allocation per worker or a guarantee that memory is free. The limit does not adjust to system load during the run. `--concurrency` accepts any positive integer, including values above six. Browser scripts, styles, and pricing requests can exceed that request count. Higher values overlap observation waits but use more memory and increase source traffic; the [performance experiments](docs/source-behavior.md#concurrency-and-correctness-experiments) record the measurements and their limits.

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

A failed crawl emits no partial catalog. A broken pipe can leave bytes already written and exits with code `1`, including when a pager closes early. Exit codes are `0` for success/help, `1` for read/scrape/write failure, `2` for invalid usage, `130` for Ctrl+C, and `143` for SIGTERM on macOS/Linux.

### Reopen a saved catalog

`--input FILE` reads a JSON catalog exported by this CLI. It opens the terminal browser under the same terminal conditions as a fresh scrape, without making network requests or launching Chrome. Copy, Save, and navigation work as usual; file actions initially use the input file. Opening or closing it does not rewrite it.

```sh
bun run scrape --input products.json
bun run scrape --input products.json -o products.csv # Convert and exit
```

The loader checks the JSON shape, cent precision, and total before opening the browser or exporting. It rejects prices or totals that JSON number conversion would round, even when the rounded number looks valid. Malformed files fail with exit code `1` and no catalog output. An empty saved catalog with total zero is valid. Only JSON files are supported as input; CSV/TSV and stdin are not. `--format` selects the export format. Saved JSON contains no original product count or crawl duration, so the loaded view reports the result count and total only. This validates the saved data's consistency, not its freshness or source coverage.

Pipes and `--no-interactive` export the loaded catalog to stdout unless `--output` names a file. CLI output still replaces an existing destination, including the input file if you explicitly use the same path for both. To reformat a file in place, use `--output`; shell redirection to the input path would truncate it before the CLI can read it.

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

Views remember their position. Selecting another product resets details scrolling; changing JSON formatting resets its preview. Copy and Save always export the entire catalog without fetching again. File actions use the input file or the latest successful save and never launch automatically.

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
- For the total, uniqueness means canonical product identity plus storage choice, not a distinct numeric price. Identical duplicate configurations collapse; conflicts fail. Different products or configurations with equal prices both count toward the total.
- Prices and totals use checked integer cents before conversion to JSON numbers. Tiny floating-point display errors such as `$517.1700000000001` normalize to cents; other unsupported precision or amounts that lose cent precision fail. Results have deterministic order; JSON numbers need not retain trailing zeros.

CSV/TSV have `name`, `description`, `price`, and `colors` columns. Each result is one row; prices have two decimal places and colors share a `; `-separated cell. They omit a total row; the summary still reports the total. Use JSON for nested colors and a total in one document.

Delimited exports use UTF-8 without a BOM, CRLF records, quoted cells for delimiters/line breaks, and doubled embedded quotes. TSV follows the same rules with tabs. Formula-like text prefixes receive a leading apostrophe; prices remain numeric. This reduces spreadsheet formula risk but does not guarantee safety across applications or save/reopen operations. JSON preserves the original text. See [CSV quoting](https://www.rfc-editor.org/rfc/rfc4180) and [formula handling](https://owasp.org/www-community/attacks/CSV_Injection).

## Develop and verify

### Implementation note for the assessment

This implementation went beyond the suggested 1–2 hour timebox. The terminal browser, extra export formats, saved-file loading, and distribution work broadened the scope beyond the core JSON scraper. Further UI features, support for other sites or control types, and performance tuning are deferred; the remaining limits are documented below.

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

[CI](.github/workflows/check.yml) runs `check`, `test:terminal`, and `test:binary`, then builds native artifacts for macOS and Linux on x64 and arm64. The benchmark is a separate manual command. Check [workflow results](https://github.com/exsesx/natter-scraper/actions/workflows/check.yml) for a specific commit. Cross-compilation alone does not establish native behavior; [platform verification](docs/distribution.md#verify-on-the-target-platform) records the test boundaries.

The toolchain pins Bun **1.4.2** and TypeScript **7.0.2**. Effect and `@effect/platform-bun` use **4.0.0-rc.115**; keep them aligned. Effect v4 is a release candidate and its `effect/unstable/cli` API is explicitly unstable. Exact dependency versions are in [package.json](package.json) and `bun.lock`.

| Core requirement | Implementation and checks |
| --- | --- |
| Follow categories, pagination, and product links | [Crawler](src/crawl.ts), [crawl tests](tests/crawl.test.ts) |
| Read fields, colors, and every enabled HDD configuration | [Browser observations](src/product-browser.ts), [HTML extraction](src/site.ts), [browser tests](tests/product-browser.test.ts) |
| Deduplicate identities and sum prices in cents | [Catalog construction](src/catalog.ts), [catalog tests](tests/catalog.test.ts) |
| Emit one JSON object without progress mixed into stdout | [CLI](src/cli.ts), [CLI contract tests](tests/cli.test.ts) |

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

Coverage is limited to pages reachable through the catalog's category, pagination, and product links. Document requests and redirects stay within its origin and subtree. Defaults are automatically selected concurrency as described above, a 15-second request or browser-operation timeout, a ten-minute crawl deadline, up to two retries for transient HTTP failures, 2 MiB of HTML per document, and 10,000 discovered URLs. A free product slot starts the next queued product immediately. Browser views are reused within the crawl with Chrome's back/forward cache disabled. Before reuse, the reader navigates to a blank document, disables interception and browser event streams, and removes listeners. A temporary hook clears session storage and the window name before the next product's scripts run; it is removed before storage-choice reloads. Views close on completion, failure, or cancellation. Deadline errors report the crawl phase and completed-product count. Browser scripts, styles, and pricing requests may load elsewhere on the same origin; third-party resources, images, fonts, and subframes are blocked. Browser resource loads do not use the HTTP adapter's retry or body-size policy.

If preparing a completed view for reuse fails, the reader closes and discards it while retaining the validated product. Recorded page/network errors, failed price observations, and cancellation still fail the crawl.

The adapter discovers one HDD button group and one color select, with up to 1,000 option selections per product. It checks each enabled storage/color combination and reads the displayed price; it contains no copied pricing formula. Storage may change available colors. Dependencies that change storage choices, colors that change the option sets, and other controls fail explicitly. Supporting new kinds of controls or layouts still requires adapter changes.

Each observation waits for 500 ms of stable product markup and idle tracked network requests, with no `aria-busy` marker. This handles the observed site and tested asynchronous updates, but cannot prove that an arbitrary later timer will never change the page. Missing fields, unsupported currency/precision, script or required-request errors, conflicting identities, and empty results fail. Dated fixtures and bounded live checks are evidence, not a guarantee of future behavior.

Linux executables target glibc, not musl. Desktop actions require [platform helpers](docs/distribution.md#desktop-actions); mocked tests do not verify actual clipboard or launcher integration. Cancellation cannot undo an action already handed to a desktop helper; a force-killed process cannot run cleanup.

AI agents assisted with implementation, tests, source inspection, and documentation. The repository contains no private recruitment correspondence.
