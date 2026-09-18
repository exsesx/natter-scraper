# Source fixtures

Captured 2026-09-17 over HTTPS. Cheerio extracted and serialized each complete `.test-site` subtree, omitting global navigation, scripts, trackers, and footer. These are normalized source fragments, not original response bytes or a complete catalog snapshot.

Automatic formatting excludes these HTML files. Git attributes preserve their saved line endings and exempt them from whitespace checks. Keep their saved markup and whitespace unchanged.

| File | Source |
| --- | --- |
| `landing.html` | [Catalog landing page](https://webscraper.io/test-sites/e-commerce/static) |
| `laptops-page-1.html` | [Laptop category](https://webscraper.io/test-sites/e-commerce/static/computers/laptops) |
| `product-31.html` | [Packard 255 G2](https://webscraper.io/test-sites/e-commerce/static/product/31) |
| `product-1.html` | [Nokia 123](https://webscraper.io/test-sites/e-commerce/static/product/1) |

See [source observations](../../../docs/source-behavior.md) for browser-confirmed prices, colors, and discovery limits. Tests label mutations of these fragments as synthetic cases. These fragments contain no scripts: they verify snapshot parsing, not interactive price changes.

Keep expected results independent of parser output. [Parser tests](../../site.test.ts) assert known source values; [browser tests](../../product-browser.test.ts) use synthetic handlers with explicit prices, dependent colors, delayed requests, and failure cases. [CLI tests](../../cli.test.ts) assert a hand-calculated catalog and total from a separate synthetic site. A passing schema check cannot prove completeness or correct prices.

Saved-catalog loading is covered separately by [input validation tests](../../input.test.ts) and [saved-input CLI tests](../../cli-input.test.ts). Those tests use explicit JSON data and do not make the captured fragments evidence of a fresh scrape.
