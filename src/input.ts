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

/** Compare the original JSON decimal with validated cents to detect Number rounding. */
function matchesCents(text: string, cents: number): boolean {
  const [coefficient = "", exponent = "0"] = text.toLowerCase().split("e");
  const [integer = "", fraction = ""] = coefficient.split(".");
  const digits = `${integer}${fraction}`.replace(/^(-?)0+/, "$1");
  const significant = digits.replace(/0+$/, "");

  if (!significant || significant === "-") return cents === 0;

  const expected = String(cents).replace(/0+$/, "");
  const scale =
    Number(exponent) - fraction.length + digits.length - significant.length + 2;

  return (
    significant === expected && scale === String(cents).length - expected.length
  );
}

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
    const numberSources = new WeakMap<object, Map<string, string>>();
    const value: unknown = yield* Effect.try({
      try: () =>
        JSON.parse(
          text,
          function (
            this: object,
            key: string,
            value: unknown,
            context?: { source?: string },
          ) {
            if (typeof value === "number" && context?.source !== undefined) {
              const fields =
                numberSources.get(this) ?? new Map<string, string>();

              fields.set(key, context.source);
              numberSources.set(this, fields);
            }

            return value;
          },
        ),
      catch: (cause) =>
        new InputError({
          message: `Could not parse JSON in ${source}: ${cause instanceof Error ? cause.message : String(cause)}. Open a JSON catalog exported by this application.`,
        }),
    });
    const cents = (
      amount: unknown,
      field: string,
      original: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount < 0
        )
          return yield* invalid(
            `${field} must be a nonnegative finite number.`,
          );

        const parsed = yield* parseMoney(String(amount)).pipe(
          Effect.mapError((error) => invalid(`${field}: ${error.message}`)),
        );

        if (original === undefined || !matchesCents(original, parsed))
          return yield* invalid(
            `${field} cannot retain its exact value at cent precision.`,
          );

        return parsed;
      });

    if (!isObject(value)) return yield* invalid("Expected an object.");
    if (Object.keys(value).some((key) => key !== "results" && key !== "total"))
      return yield* invalid("Only results and total fields are allowed.");
    if (!Array.isArray(value.results))
      return yield* invalid("results must be an array.");

    const totalCents = yield* cents(
      value.total,
      "total",
      numberSources.get(value)?.get("total"),
    );
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

      const priceCents = yield* cents(
        item.price,
        `${field}.price`,
        numberSources.get(item)?.get("price"),
      );
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
