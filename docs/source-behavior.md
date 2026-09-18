# Source behavior and verification

Initial observations were made 2026-09-17 through public HTML and browser selections. On 2026-09-18 the Bun.WebView adapter checked products 31 and 1 directly, selecting every enabled storage/color option. These samples do not establish full catalog coverage; a subsequent complete crawl is recorded below. Saved fragments and capture details are in [tests/fixtures/source](../tests/fixtures/source/README.md).

## Observed product behavior

| Product | Initial / 128 GB | 256 GB after click | 512 GB after click | Other controls |
| --- | --- | --- | --- | --- |
| [31: Packard 255 G2](https://webscraper.io/test-sites/e-commerce/static/product/31) | $416.99 | $436.99 | $456.99 | 1024 GB disabled |
| [33: ThinkPad T540p](https://webscraper.io/test-sites/e-commerce/static/product/33) | $1178.99 | $1198.99 | $1218.99 | 1024 GB disabled |
| [1: Nokia 123](https://webscraper.io/test-sites/e-commerce/static/product/1) | $24.99; no storage control | n/a | n/a | Gold, White, Black color selector |

Browser selections confirmed the laptop prices above on 2026-09-17. The 2026-09-18 production adapter again observed product 31 at $416.99, $436.99, and $456.99, totaling $1310.97, with disabled 1024 excluded. That bounded check did not include product 33. Product 1's `.dropdown select[aria-label="color"]` has an empty-value placeholder. All three enabled colors produced $24.99 on 2026-09-18; its result retained the name "Nokia 123" and colors Black, Gold, White. Color selections append a title suffix; output keeps the name observed before selecting colors.

Product 31's description says 500GB although its active option is 128. Keep descriptions independent of selectable storage, and take full names from detail pages because listing text can be truncated.

## Browser observation and parser boundary

The adapter executes the page in an isolated headless Chrome view through Bun.WebView. It does not inspect the site's JavaScript or copy its pricing formula. The HTTP adapter fetches a bounded document; request interception renders those bytes at the real URL. Same-origin scripts, styles, and pricing requests are allowed. Other origins, images, fonts, and subframes are blocked. Any attempted main-frame navigation away from the expected product fails before being followed.

The parser recognizes one HDD button group and one color select. It discovers enabled option keys and labels without a fixed capacity list. Each storage choice is clicked, its selected state verified, and its displayed price read. The page resets between storage choices. Colors are rediscovered after selecting storage, then each enabled color is selected through its DOM value and standard input/change events. Their prices and descriptions must agree to fit one result with a colors array. Storage choices remain separate even when their prices agree. A color that changes option availability, storage that changes other storage choices, or an unknown control fails explicitly.

On product 31 a storage click replaces the entire price heading, removing its nested USD metadata. The reader validates currency on the initial rendered page and retains that evidence for later snapshots; any conflicting metadata still fails. Each reset requires fresh currency evidence. Prices and totals remain checked integer cents.

The 2026-09-18 full-crawl verification exposed a rendered price of `$517.1700000000001`. A subsequent bounded browser check of [product 92: Dell Vostro 15 (3568) Red](https://webscraper.io/test-sites/e-commerce/static/product/92) observed $497.17, $517.17, and $537.17 across its three enabled storage choices, totaling $1551.51 after cent normalization. Page arithmetic can produce this long representation for a cent amount. The snapshot parser accepts only a decimal matching JavaScript's own number representation, within `abs(amount) * Number.EPSILON` of two decimal places, capped at $0.000000001. It then uses the strict checked-cent parser. Fractional-cent prices such as `$517.171`, lossy decimal strings, and amounts that cannot retain cent precision still fail. This normalizes the displayed value without inferring prices for unselected options.

Observations require 500 ms of stable product markup and idle tracked requests, with no `aria-busy` marker. Delayed pricing requests, missing selections, page script errors, request failures, settling timeouts, and cancellation are covered by synthetic browser tests. There is a 1,000-selection limit per product. A late timer without a busy or network signal can still fall outside the observation window. This is a supported-control adapter, not a universal scraper: new layouts, control types, or cross-origin pricing dependencies require review. No full-catalog performance claim follows from these samples.

## Performance checks on 2026-09-18

A local synthetic fixture measured the production browser reader before and after reusing views across products. Storage used three enabled choices, with explicit prices of $10.11, $37.29, and $37.29. The color case selected two colors for each storage choice. Catalogs and totals were identical before and after. Measurements used macOS arm64, Bun 1.4.2, and Chrome, with two observations per browser case. The plain-product comparison excludes initial browser startup; the storage figures are means of the two observations.

| Fixture | Before | After |
| --- | ---: | ---: |
| Plain product, warm browser | 1.19 s | 0.65 s |
| Three storage choices | 3.87 s | 3.37 s |
| Three storage choices, two colors each | 7.03 s | 6.60 s |
| Six uneven product reads at concurrency two, median of three runs | 0.915 s | 0.649 s |

The scheduling fixture used alternating 300 ms and 30 ms readers. It verifies that the next product starts as soon as either slot is free. A separate gated regression test requires a queued reader to start before the slow first reader can finish; fixed batches cannot pass it. Browser regressions cover view reuse, fresh document and currency state, tab-local storage isolation, and disposal. The 500 ms observation window and resets between storage choices remain in place. These are local measurements, not a full-catalog speedup estimate.

Three storage choices still require six observations, with at least 3 s of quiet time in total. Adding two colors per storage choice adds six observations, bringing that minimum to 6 s. The measured browser times are close to those limits. Removing resets or reducing the observation window would change what the reader verifies and needs separate evidence for state carryover and delayed updates.

The full production crawl from this first pass on 2026-09-18 completed in **321.189 s (5 min 21 s)** at concurrency two: **179 pages, 147 products, 423 result rows, and a total of $345,701.52**, with no HTTP retries. It selected every enabled storage/color combination discovered by the adapter. The resulting catalog exactly matched the saved pre-change catalog, including 72 rows with color arrays. A separate calculation summed the exported decimal prices using `BigInt` cents and confirmed 34,570,152 cents. Matching the saved catalog is a parity check; the new prices themselves came from browser observations.

This run exceeded the previous five-minute deadline. The default is now ten minutes, and a deadline failure includes its phase and completed-product count. That timeout change gives the browser workflow room to finish; it is separate from the measured performance improvements. There is no completed baseline full crawl from this comparison, so the fixture gains above are not a whole-catalog speedup claim.

For that first pass, `bun run check` passed type checking, linting, and all **214 tests**; `bun run test:terminal` passed all **16 terminal cases**. Checks ran on macOS arm64 with Bun 1.4.2 and Chrome 153.0.8010.53. Standalone builds and other native platforms were not reverified in that pass.

## Concurrency and correctness experiments

A second performance pass on 2026-09-18 compared higher concurrency with two extraction shortcuts. The CLI accepts `--concurrency N`, with an automatic startup default capped at six based on the measurements below. The limit applies to active products and discovery document requests; a browser can make several resource requests for one product.

| Candidate | Observed result | Decision |
| --- | --- | --- |
| Shorten stable-state wait from 500 ms to 100 ms | Three synthetic cases returned the old $10.11 or an intermediate $20.22 instead of the final $71.83 after a 300 ms timer | Retain 500 ms |
| Skip storage reloads for products without colors | Hidden click history changed later prices to $99.99 and carried descriptions forward | Retain reloads |
| Skip all storage reloads | Later names retained a previous color suffix, descriptions accumulated, and fresh-document currency validation was skipped | Retain reloads |
| Increase product concurrency | Completed full live crawls at 4, 6, and 8 with identical output and no retries | Expose `--concurrency`; cap the automatic default at 6 |

The timer experiments retained request tracking and selection validation. Both waits handled an unchanged price and an 800 ms tracked pricing request, but only the existing window passed all five cases. Bounded rendered checks of products 31 and 1 found no explicit completion marker in the product wrapper. A selected control, a changed price, or idle network alone cannot prove that an unannounced timer has finished. The 500 ms window remains a documented heuristic, not a universal completion guarantee.

The rejected implementations were temporary experiments. Regression tests retain their failing examples against the production reader; no unsafe fast mode or copied price formula was added. A bounded production check of product 92 also retained its three observed prices and $1551.51 total.

Memory sampling found that Chrome retained completed documents in its back/forward cache even though extraction never navigates back. Clearing navigation history did not release those renderers. The browser now launches with `--disable-features=BackForwardCache`, a [Chromium-supported flag](https://chromium.googlesource.com/chromium/src/+/7f1fdb75589801292a49e3bb4d53c282f50bef6e). In a ten-product probe, the default browser ended with 11 renderer processes and peaked at 1954 MiB of process-tree RSS. Disabling the cache kept five renderer processes and peaked at 1381 MiB. These counts include browser baseline renderers, not just active product tabs.

A lifecycle regression checks that a completed document's `pagehide` event reports `persisted: false`. Another regression exposed session data written during `pagehide`, after the old cleanup ran. A temporary script now clears `sessionStorage` and `window.name` at the start of the next product, before its scripts execute. The adapter removes this script before storage-choice reloads, preserving within-product state and fresh-document validation.

Full live measurements used an Apple M1 Pro with ten CPU cores and 16 GiB RAM, macOS arm64, Bun 1.4.2, and Chrome. Runs were serial, with no other scraper tests running alongside them. Each completed run found 147 products across 179 pages, produced exactly the same 423 rows and $345,701.52 total as the verified reference, and reported zero HTTP retries.

| Concurrency | Elapsed | Peak sampled process-tree RSS | Implementation |
| --- | ---: | ---: | --- |
| 2 | 321.189 s | Not sampled | Earlier first-pass baseline |
| 4 | 160.863 s | 5555 MiB | Before disabling back/forward cache |
| 4 | 160.124 s | 2057 MiB | Cache and tab-state cleanup fixes |
| 6 | 104.403 s | 2478 MiB | Cache and tab-state cleanup fixes |
| 8 | 84.747 s | 3335 MiB | Cache and tab-state cleanup fixes |

Eight was the fastest tested setting on this machine; six used less process memory and still finished in under two minutes. Six therefore caps the automatic default, balancing the measured elapsed time and browser memory. Use `bun run scrape --concurrency 8 -o products.json` to select the fastest tested setting, or choose a lower value to reduce concurrency. CPU count alone cannot determine the best setting: browser memory, observation waits, network conditions, and source capacity also matter. These are individual live runs, not a statistical optimum or a recommendation for other sources.

RSS sums the scraper and its browser descendants once per second and may count shared memory more than once; it is not unique physical memory. Background system activity and network conditions were uncontrolled. Global swap counters were recorded but cannot attribute swapping to this scraper. An interrupted eight-slot run is excluded from the table.

The current startup default is `max(1, min(6, available CPUs, floor(total RAM / 2 GiB)))`, using `availableParallelism()` rather than a physical-core count. The 2 GiB per slot is a heuristic based on total RAM; the RSS samples do not establish a per-worker memory allocation. This lowers the default on machines with fewer available CPUs or less RAM, but does not account for current system load or adjust during a run. `--concurrency N` overrides the result, including values above six. Neither the formula nor the measured cap establishes an optimum for another machine.

Run `bun run benchmark` to reproduce the offline concurrency comparison. It uses the production crawler against 12 loopback products with plain, storage, color, and storage-plus-color controls. Each run must produce the independently specified 24 rows and $568.80 total. After a one-product warmup, the script measures 2/4/6/8 and then 8/6/4/2. These fixtures isolate scheduling and browser overhead; they do not model the live site's network or script costs.

All eight benchmark runs on 2026-09-18 passed their output checks with no retries. Elapsed seconds were:

| Concurrency | Ascending-order round | Descending-order round |
| --- | ---: | ---: |
| 2 | 21.284 | 21.415 |
| 4 | 14.565 | 13.933 |
| 6 | 12.006 | 11.953 |
| 8 | 12.186 | 10.637 |

This small mixed fixture has less parallel work than the live catalog, so six and eight finish close together. It checks repeatable output and the effect of concurrency; it does not establish a universal best setting.

The 2026-09-18 checkpoint, before saved-catalog input and automatic concurrency were added, passed `bun run check` with **247 tests**, type checking, and linting; `bun run test:terminal` passed **16 cases**. `bun run test:binary` passed native macOS arm64 exports and compiled terminal checks, including execution outside the checkout with no Bun on `PATH`. Desktop helpers remained mocked. Other native platforms and the remote CI matrix were not executed in this pass. Review also added a browser regression that rejects multiple rendered product wrappers instead of silently reading only the first.

Saved-catalog input (`--input FILE`) does not revisit these pages or observe prices. It validates the exported JSON shape, cent precision, and total before browsing or converting the data. Passing that validation establishes internal consistency, not current prices or source coverage.

## Discovery evidence

The [landing page](https://webscraper.io/test-sites/e-commerce/static) links Computers and Phones through `#side-menu`. The [laptop category](https://webscraper.io/test-sites/e-commerce/static/computers/laptops) exposes laptop/tablet subcategories, six products, and `.pagination a[href]` links to pages 2 and 20. Its initial pagination window omits middle pages, so discovery follows links recursively. The [touch-phone category](https://webscraper.io/test-sites/e-commerce/static/phones/touch) linked product 1.

Discovery reads navigation, pagination, and product-title links inside `.test-site`. The crawler restricts URLs to the target origin/subtree and deduplicates canonical URLs. Finishing its queue covers pages reachable through these selectors, not unseen markup changes. Featured landing products alone cannot establish inventory.

The category fixture advertises 117 items and shows six cards. The parser assumes six cards per page and checks `.item-count` against the requested page, including the final-page remainder. It also requires title links on product cards, pagination for multi-page inventory, and select/options in color dropdowns. These checks catch partial markup changes; a new layout requires new evidence and parser changes.

## Fixtures and limits

Tests mutate the four saved fragments for synthetic invalid fields, new storage capacities, unsupported currency, disabled choices, and duplicate colors. Product 1's original colors come from captured source. Separate synthetic pages exercise real browser interactions with explicit prices that differ from the old site's increments, equal-price identities, storage-dependent colors, asynchronous responses, and incompatible color prices.

The 2026-09-17 pass fetched the landing page, both categories above, products 31/1, and app.js over HTTPS. Browser checks visited products 31/33/1. It performed no full crawl; subsequent integration checks must report their own dates and counts.

The initial 2026-09-18 bounded live check used the production WebView reader on products 31 and 1 on macOS arm64 with Bun 1.4.2 and Chrome 153.0.8010.53. It produced three storage rows and one color-grouped phone row with the values above. That check covered only those two products; the later full-crawl result is recorded in the performance section. Neither check verified other native platforms.

The planning read of [robots.txt](https://webscraper.io/robots.txt) listed disallowed `/test-sites/product/`, `/test-sites/pagination/`, `/test-sites/pagination*?page=`, `/test-sites/scroll/`, and `/test-sites/load-more/` prefixes. None matched this legacy `/test-sites/e-commerce/static/` target. This records the rules observed then, not their current state. No authentication or anti-bot bypass was used.
