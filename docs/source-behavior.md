# Source behavior and verification

Checked 2026-09-17 against public source HTML, its first-party JavaScript, and browser selections. This is representative source verification, not a full catalog crawl. Real HTML fragments are in [tests/fixtures/source](../tests/fixtures/source/README.md).

## Observed product behavior

| Product | Initial / 128 GB | 256 GB after click | 512 GB after click | Other controls |
| --- | --- | --- | --- | --- |
| [31: Packard 255 G2](https://webscraper.io/test-sites/e-commerce/static/product/31) | $416.99 | $436.99 | $456.99 | 1024 GB disabled |
| [33: ThinkPad T540p](https://webscraper.io/test-sites/e-commerce/static/product/33) | $1178.99 | $1198.99 | $1218.99 | 1024 GB disabled |
| [1: Nokia 123](https://webscraper.io/test-sites/e-commerce/static/product/1) | $24.99; no storage control | — | — | Gold, White, Black color selector |

The laptop amounts above were observed in the browser after selecting enabled buttons. Selecting 128 again on product 31 restored $416.99. Product 1 has a real `.dropdown select[aria-label="color"]` with an empty-value placeholder. Selecting Gold changed its title to “Nokia 123 Gold” while its displayed price remained $24.99. Output retains the initial name and groups selectable colors in an array rather than creating a color cross-product.

Product 31's source description says 500GB even though the active storage option is 128. Preserve descriptions independently from selectable configuration data. Detail names are full text; listing link text can be truncated and must not become the final name.

## Price rule and parser boundary

The [first-party app.js](https://webscraper.io/js/app.js?id=9aefa6ccaac23dd7a6624602b2f9c6da) was fetched again during implementation. Its e-commerce route instantiates `EcommerceProduct`, whose `initialize` reads the original `h4.price`. `updatePrice` adds $20 for value 256, $40 for 512, $60 for 1024, and zero otherwise. The handler uses local arithmetic and replaces the price heading's text; it does not call a pricing API. Its color change handler updates the title only. Do not confuse this view with the separate cars/test-sites swatch handler in the same bundle.

The scraper implements this narrowly verified rule in integer cents. It requires USD metadata and the initial active 128 control, accepts only known capacity values and matching labels, and rejects unknown option markup rather than silently assigning a base price. Enabled controls alone become results. The 1024 branch is source-code evidence; both sampled laptops disable it, so it has no browser-observed enabled price in these samples. Browser clicks confirm the enabled 128/256/512 rule, not every future product or script revision.

The static HTML includes everything needed by this adapter, so runtime browser installation is unnecessary. This is a source-specific maintenance tradeoff, not a measured performance claim. If the script or option model changes, update evidence and fixtures before adapting the parser. A changed JavaScript pricing rule without changed HTML is not automatically detected by the scraper; the bounded live check and dated fixtures do not eliminate that risk.

## Discovery evidence

The [landing page](https://webscraper.io/test-sites/e-commerce/static) links Computers and Phones through `#side-menu`. The [laptop category](https://webscraper.io/test-sites/e-commerce/static/computers/laptops) exposes laptop/tablet subcategories, six product links, and `.pagination a[href]` links including next page 2 and final page 20. Its pagination window omits some middle pages initially; follow links recursively instead of guessing page numbers. The [touch-phone category](https://webscraper.io/test-sites/e-commerce/static/phones/touch) provided the link to product 1.

Discovery reads only site navigation, pagination, and product-title links inside `.test-site`; the crawl layer enforces origin/subtree scope and deduplicates canonical URLs. Featured landing products are not the complete inventory. A complete queue is evidence of reachable-page coverage under these selectors, not proof against an unseen markup change.

The category fixture advertises 117 items and shows six cards on page 1. The parser checks the static site's six-items-per-page layout against `.item-count` and the requested page number, including the final-page remainder. Recognizable product cards must each retain a title link; advertised multi-page inventory must retain pagination. Recognizable color dropdowns must retain their select/options. These guards turn partial selector drift into errors. A site layout change requires updating this adapter and its source evidence.

## Fixtures and limits

Four real `.test-site` fragments retain source markup while omitting global navigation, scripts, trackers, and footer. Their provenance is listed in the [fixture README](../tests/fixtures/source/README.md). Tests mutate those fixtures for explicitly synthetic invalid fields, unknown storage, unsupported currency, disabled choices, and duplicate colors. No synthetic color case is presented as the source of the actual product 1 options.

This source-verification pass fetched the landing, laptop category, touch-phone category, products 31/1, and the public app script through ordinary HTTPS. Browser checks visited products 31/33/1. No full catalog crawl was performed in this pass, and sampled data does not establish global inventory counts. Integration verification must report its own counts and dates.

The earlier planning read of [robots.txt](https://webscraper.io/robots.txt) listed disallowed `/test-sites/product/`, `/test-sites/pagination/`, `/test-sites/pagination*?page=`, `/test-sites/scroll/`, and `/test-sites/load-more/` prefixes, which do not match this legacy `/test-sites/e-commerce/static/` target. That describes the observed rules only. No authentication or anti-bot bypass was used.
