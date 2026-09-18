# Source fixtures

Captured 2026-09-17 with ordinary HTTPS requests. Each HTML file preserves the complete `.test-site` subtree; unrelated navigation, scripts, trackers, and footer were removed using Cheerio. These are real source fragments, not a complete catalog snapshot.

Captured HTML is intentionally excluded from automatic formatting to preserve the saved markup and whitespace. Git attributes also preserve its line endings and exempt it from whitespace checks; application code keeps normal whitespace checks.

| File | Source |
| --- | --- |
| `landing.html` | https://webscraper.io/test-sites/e-commerce/static |
| `laptops-page-1.html` | https://webscraper.io/test-sites/e-commerce/static/computers/laptops |
| `product-31.html` | https://webscraper.io/test-sites/e-commerce/static/product/31 |
| `product-1.html` | https://webscraper.io/test-sites/e-commerce/static/product/1 |

Product 31 prices were also observed after browser selections: 128 GB \$416.99, 256 GB \$436.99, 512 GB \$456.99; 1024 is disabled. Product 1 has actual selectable Gold, White, and Black colors and a \$24.99 price. Selecting Gold changed its title to Nokia 123 Gold and left the price unchanged. Tests that mutate these fragments are explicitly synthetic edge cases.

The landing page's featured products can change independently of the category inventory. Pagination links are more authoritative for full catalog discovery. See [source behavior](../../../docs/source-behavior.md) for the pricing assumption and browser evidence.
