import { extname } from "node:path";
import { Data, Effect } from "effect";
import type { OutputFormat } from "./types";

export class OutputFormatError extends Data.TaggedError("OutputFormatError")<{
  readonly message: string;
}> {}

export function inferOutputFormat(path: string): OutputFormat | undefined {
  const extension = extname(path).slice(1).toLowerCase();

  return extension === "json" || extension === "csv" || extension === "tsv"
    ? extension
    : undefined;
}

export function resolveOutputFormat(
  requested: OutputFormat | "auto",
  path?: string,
): Effect.Effect<OutputFormat, OutputFormatError> {
  if (requested !== "auto") return Effect.succeed(requested);

  if (path === undefined || path === "-") return Effect.succeed("json");

  const format = inferOutputFormat(path);

  if (format) return Effect.succeed(format);

  return Effect.fail(
    new OutputFormatError({
      message: `Cannot infer output format from ${JSON.stringify(path)}. Use a .json, .csv, or .tsv extension, or set --format json, csv, or tsv.`,
    }),
  );
}
