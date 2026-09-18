import { Effect } from "effect";
import type { ProductReader } from "../../src/product-browser";
import { parseProduct } from "../../src/site";

/** Transport-only tests have no interactive controls; browser behavior is tested separately. */
export const staticProduct: ProductReader = (html, url) =>
  parseProduct(html, url).pipe(
    Effect.map((snapshot) => ({
      id: snapshot.id,
      name: snapshot.name,
      description: snapshot.description,
      colors: snapshot.colors.map((choice) => choice.label),
      variants: [{ key: "base", priceCents: snapshot.priceCents }],
    })),
  );
