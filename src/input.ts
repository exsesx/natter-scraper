import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Data, Effect } from "effect";
import { parseMoney } from "./catalog";
import type { Catalog, ResultItem } from "./types";

export class InputError extends Data.TaggedError("InputError")<{
  readonly message: string;
}> {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Load an exported JSON catalog without scraping or changing its contents. */
export function readCatalog(path: string): Effect.Effect<Catalog, InputError> {
  return Effect.gen(function* () {
    const source = resolve(path);
    const invalid = (message: string) =>
      new InputError({ message: `Invalid catalog in ${source}: ${message}` });
    const text = yield* Effect.tryPromise({
      try: (signal) => readFile(source, { encoding: "utf8", signal }),
      catch: (cause) =>
        new InputError({
          message: `Could not read ${source}: ${cause instanceof Error ? cause.message : String(cause)}. Check the path and read permissions.`,
        }),
    });
    const value: unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: (cause) =>
        new InputError({
          message: `Could not parse JSON in ${source}: ${cause instanceof Error ? cause.message : String(cause)}. Open a JSON catalog exported by this application.`,
        }),
    });
    const cents = (amount: unknown, field: string) =>
      Effect.gen(function* () {
        if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount < 0
        )
          return yield* invalid(
            `${field} must be a nonnegative finite number.`,
          );

        return yield* parseMoney(String(amount)).pipe(
          Effect.mapError((error) => invalid(`${field}: ${error.message}`)),
        );
      });

    if (!isObject(value)) return yield* invalid("Expected an object.");
    if (Object.keys(value).some((key) => key !== "results" && key !== "total"))
      return yield* invalid("Only results and total fields are allowed.");
    if (!Array.isArray(value.results))
      return yield* invalid("results must be an array.");

    const totalCents = yield* cents(value.total, "total");
    const results: ResultItem[] = [];
    let sum = 0;

    for (const [index, item] of value.results.entries()) {
      const field = `results[${index}]`;

      if (!isObject(item)) return yield* invalid(`${field} must be an object.`);
      if (
        Object.keys(item).some(
          (key) => !["name", "description", "price", "colors"].includes(key),
        )
      )
        return yield* invalid(`${field} has an unknown field.`);
      if (!nonemptyString(item.name))
        return yield* invalid(`${field}.name must be a nonempty string.`);
      if (typeof item.description !== "string")
        return yield* invalid(`${field}.description must be a string.`);

      const priceCents = yield* cents(item.price, `${field}.price`);
      let colors: string[] | undefined;

      if ("colors" in item) {
        if (
          !Array.isArray(item.colors) ||
          item.colors.length < 2 ||
          !item.colors.every(nonemptyString) ||
          new Set(item.colors).size !== item.colors.length
        )
          return yield* invalid(
            `${field}.colors must contain at least two unique nonempty strings.`,
          );

        colors = item.colors;
      }

      sum += priceCents;

      if (!Number.isSafeInteger(sum))
        return yield* invalid(
          "The sum of prices exceeds the safe cents range.",
        );

      results.push({
        name: item.name,
        description: item.description,
        price: item.price as number,
        ...(colors === undefined ? {} : { colors }),
      });
    }

    if (sum !== totalCents)
      return yield* invalid(
        "total must equal the sum of result prices in cents.",
      );

    return { results, total: value.total as number };
  });
}
