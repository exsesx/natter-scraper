import { Data, Effect } from "effect";
import type { Catalog, ResultItem, SourceProduct } from "./types";

export class CatalogError extends Data.TaggedError("CatalogError")<{
  readonly message: string;
}> {}

const invalid = (message: string) => new CatalogError({ message });

/** USD decimal text to cents, without first converting the amount to a float. */
export function parseMoney(text: string): Effect.Effect<number, CatalogError> {
  return Effect.gen(function* () {
    const match = /^\$?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text.trim());

    if (!match?.[1])
      return yield* invalid(`Unsupported USD price: ${JSON.stringify(text)}`);

    const cents =
      BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));

    if (cents > BigInt(Number.MAX_SAFE_INTEGER))
      return yield* invalid("Price exceeds safe cents range");

    const value = Number(cents);
    yield* centsToNumber(value);

    return value;
  });
}

/** Reject amounts whose public JSON number cannot retain the exact cent value. */
export function centsToNumber(
  cents: number,
): Effect.Effect<number, CatalogError> {
  return Effect.gen(function* () {
    if (!Number.isSafeInteger(cents) || cents < 0)
      return yield* invalid("Invalid or unsafe cents amount");

    const amount = cents / 100;
    const decimal = /^(\d+)(?:\.(\d{1,2}))?$/.exec(JSON.stringify(amount));

    if (
      !decimal?.[1] ||
      BigInt(decimal[1]) * 100n + BigInt((decimal[2] ?? "").padEnd(2, "0")) !==
        BigInt(cents)
    ) {
      return yield* invalid(
        "Amount cannot round-trip through a JSON number at cent precision",
      );
    }

    return amount;
  });
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export function buildCatalog(
  products: SourceProduct[],
): Effect.Effect<Catalog, CatalogError> {
  return Effect.gen(function* () {
    if (products.length === 0)
      return yield* invalid("The catalog is unexpectedly empty");

    const identities = new Map<
      string,
      { id: string; key: string; item: ResultItem; cents: number }
    >();
    const sources = new Map<string, string>();

    for (const product of products) {
      if (
        !product.id ||
        !normalize(product.name) ||
        !normalize(product.description)
      ) {
        return yield* invalid(
          `Missing required product field: ${product.id || "unknown identity"}`,
        );
      }

      if (product.variants.length === 0)
        return yield* invalid(`No enabled configurations: ${product.id}`);

      const colors = [
        ...new Set(product.colors.map(normalize).filter(Boolean)),
      ].sort(compare);
      const metadata = JSON.stringify([
        product.name,
        product.description,
        colors,
        [...new Set(product.variants.map((variant) => variant.key))].sort(
          compare,
        ),
      ]);
      const previous = sources.get(product.id);

      if (previous !== undefined && previous !== metadata)
        return yield* invalid(`Conflicting product: ${product.id}`);

      sources.set(product.id, metadata);

      for (const variant of product.variants) {
        if (!variant.key)
          return yield* invalid(
            `Missing configuration identity: ${product.id}`,
          );

        const label =
          variant.label &&
          normalize(variant.label).replace(/^(\d+)\s*GB$/i, "$1 GB");
        const variantName = variant.name ?? product.name;
        const variantColors = variant.colors
          ? [...new Set(variant.colors.map(normalize).filter(Boolean))].sort(
              compare,
            )
          : colors;
        const name =
          label && !variantName.endsWith(` (${label})`)
            ? `${variantName} (${label})`
            : variantName;
        const item: ResultItem = {
          name,
          description: variant.description ?? product.description,
          price: yield* centsToNumber(variant.priceCents),
          ...(variantColors.length >= 2 ? { colors: variantColors } : {}),
        };

        const identity = JSON.stringify([product.id, variant.key]);
        const prior = identities.get(identity);

        if (prior && JSON.stringify(prior.item) !== JSON.stringify(item)) {
          return yield* invalid(
            `Conflicting configuration: ${product.id} / ${variant.key}`,
          );
        }

        identities.set(identity, {
          id: product.id,
          key: variant.key,
          item,
          cents: variant.priceCents,
        });
      }
    }

    const rows = [...identities.values()].sort(
      (a, b) =>
        compare(a.id, b.id) ||
        (/^\d+$/.test(a.key) && /^\d+$/.test(b.key)
          ? Number(a.key) - Number(b.key)
          : compare(a.key, b.key)),
    );

    let total = 0;

    for (const row of rows) {
      total += row.cents;

      if (!Number.isSafeInteger(total))
        return yield* invalid("Catalog total exceeds safe cents range");
    }

    return {
      results: rows.map((row) => row.item),
      total: yield* centsToNumber(total),
    };
  });
}
