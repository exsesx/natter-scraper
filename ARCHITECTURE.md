# Data flow

The [architecture guide](docs/architecture.md) maps modules and extension points. This diagram follows data and output decisions, not function calls.

```mermaid
flowchart TD
    CLI["main.ts / cli.ts<br/>Validate options and choose output mode"] --> SOURCE{"--input supplied?"}
    SOURCE -->|"Yes"| INPUT["input.ts<br/>Read JSON; validate fields, cents, and total"]
    SOURCE -->|"No"| DISCOVER["crawl.ts<br/>Queue scoped categories and pagination"]
    DISCOVER -->|"Next listing batch"| LISTHTTP["http.ts<br/>Fetch listing documents"]
    LISTHTTP --> LISTPARSE["site.ts / parseListing<br/>Find category, page, and product links"]
    LISTPARSE -->|"Queue new links"| DISCOVER
    DISCOVER -->|"Discovery finished"| PRODUCTS["crawl.ts<br/>Fetch and observe products in bounded slots"]
    PRODUCTS --> PRODUCTHTTP["http.ts<br/>Fetch each product document"]
    PRODUCTHTTP --> WEBVIEW["product-browser.ts / Bun.WebView<br/>Render document; select storage and colors"]
    WEBVIEW -->|"Settled markup"| SNAPSHOT["site.ts / parseProduct<br/>Validate one displayed configuration"]
    SNAPSHOT -->|"Observed fields and choices"| WEBVIEW
    WEBVIEW -->|"All products and configurations observed"| CATALOG["catalog.ts<br/>Validate identities; order rows; sum cents"]
    CATALOG --> MODE{"Interactive output selected?"}
    INPUT --> MODE
    MODE -->|"No"| DIRECT["format.ts / output.ts<br/>Write file or stdout export"]
    MODE -->|"Yes"| INITIAL["Write initial file if --output was supplied"]
    INITIAL --> BROWSER["ui.tsx / browser*.tsx<br/>Browse retained results in the terminal"]
    BROWSER -->|"Save"| SAVE["browser-actions.ts / output.ts<br/>Save; confirm before replacing an existing file"]
    SAVE -->|"Saved path or error"| BROWSER
    BROWSER -->|"Copy or open"| DESKTOP["desktop.ts<br/>Clipboard, file, folder"]
    DESKTOP -->|"Feedback"| BROWSER
    DIRECT --> EXIT["Print summary and exit"]
    BROWSER --->|"Close"| EXIT
```

The terminal mode is chosen during flag validation. For an interactive scrape, its progress screen starts before discovery; the result browser shown above appears only after the catalog and any initial file write succeed. With `--input`, validation finishes before the terminal starts. Importing makes no network requests and launches no extraction browser.

Listing discovery runs in batches. Product slots stay occupied as work finishes, so the next product need not wait for an entire batch. The default slot count is a CPU/RAM heuristic from one to six; `--concurrency` overrides it. These limits apply to crawler work, not every resource request made by Chrome.

HTTP supplies documents; it does not calculate configuration prices. The browser executes the page's own controls and reads their results. Same-origin scripts, styles, and pricing requests can run during those observations.

An initial write failure ends the run; a browser action failure returns to the browser. Source and catalog failures occur before any export. [Effect finalizers](docs/effect.md#failure-and-cleanup) release resources on failure or cancellation before the CLI reports the outcome.
