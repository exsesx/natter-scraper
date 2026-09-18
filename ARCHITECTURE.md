# Data flow

The [architecture guide](docs/architecture.md) maps modules and extension points. This diagram follows data and output decisions, not function calls.

```mermaid
flowchart TD
    CLI["main.ts / cli.ts<br/>Validate options and select output mode"] --> CRAWL["crawl.ts<br/>Discover links, then fetch products"]
    CRAWL --> HTTP["http.ts<br/>Scoped fetch, timeout, retries"]
    HTTP -->|"Listing HTML"| SITE["site.ts<br/>Parse links and observed fields"]
    SITE -->|"Discovered links"| CRAWL
    HTTP -->|"Product HTML"| WEBVIEW["product-browser.ts / Bun.WebView<br/>Select storage and colors, observe prices"]
    WEBVIEW -->|"Settled markup"| SITE
    WEBVIEW -->|"All required configurations"| CATALOG["catalog.ts<br/>Validate identities and sum cents"]
    CATALOG --> MODE{"Browser eligible?"}
    MODE -->|"No"| DIRECT["format.ts / output.ts<br/>Write complete file or stdout export"]
    MODE -->|"Yes"| INITIAL["Write initial file if -o and -i were supplied"]
    INITIAL --> BROWSER["ui.tsx / browser*.tsx<br/>Browse the retained catalog"]
    BROWSER -->|"Save"| SAVE["browser-actions.ts / output.ts<br/>Save with replacement confirmation"]
    SAVE -->|"Saved path or error"| BROWSER
    BROWSER -->|"Copy or open"| DESKTOP["desktop.ts<br/>Clipboard, file, folder"]
    DESKTOP -->|"Feedback"| BROWSER
    DIRECT --> EXIT["Print summary and exit"]
    BROWSER -->|"Close and restore screen"| EXIT
```

An initial write failure ends the run; a browser action failure returns to the browser. Source and catalog failures occur before any export. [Effect finalizers](docs/effect.md#failure-and-cleanup) release resources on failure or cancellation before the CLI reports the outcome.
