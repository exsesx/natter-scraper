/** Synthetic miniature catalog. Expectations are hand-calculated in cli.test.ts. */
const prefix = "/test-sites/e-commerce/static";
const listing = (products: number[], next = "") => `<div class="test-site">
  <div id="side-menu"><a href="${prefix}">Catalog</a></div>
  ${products.map((id) => `<a class="title" href="${prefix}/product/${id}">Short title</a>`).join("")}
  ${next ? `<ul class="pagination"><a href="${prefix}${next}">Next</a></ul>` : ""}
</div>`;

export function fixturePage(path: string, search: string): string | undefined {
  if (path === prefix)
    return search ? listing([3]) : listing([1, 1, 2], "?page=2");

  if (path === `${prefix}/product/1`)
    return `<div class="test-site"><div class="product-wrapper">
    <h4 class="title">Fixture Laptop</h4><p class="description">A laptop &amp; charger.</p>
    <h4 class="price">$100.10</h4><meta itemprop="priceCurrency" content="USD">
    <label class="memory">HDD:</label><div class="swatches">
      <button value="128" class="active">128</button><button value="256">256</button>
      <button value="512" disabled>512</button><button value="1024" disabled>1024</button>
    </div></div></div>`;

  if (path === `${prefix}/product/2` || path === `${prefix}/product/3`) {
    const name = path.endsWith("/2") ? "Color phone" : "Pagination phone";

    return `<div class="test-site"><div class="product-wrapper">
      <h4 class="title">${name}</h4><p class="description">A phone.</p>
      <h4 class="price">$24.99</h4><meta itemprop="priceCurrency" content="USD">
      ${path.endsWith("/2") ? '<div class="dropdown"><select aria-label="color"><option value="">Select</option><option>White</option><option>Black</option><option>White</option></select></div>' : ""}
    </div></div>`;
  }

  return undefined;
}

export { prefix as fixturePrefix };
