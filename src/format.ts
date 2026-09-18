import type { Catalog, OutputFormat } from "./types";

function textCell(value: string, delimiter: string): string {
  // Mitigate common spreadsheet formula prefixes before delimiter escaping.
  const text = /^[\t\r\n]|^\s*[=+\-@]/u.test(value) ? `'${value}` : value;

  return text.includes(delimiter) || /["\t\r\n]/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function serializeDelimited(catalog: Catalog, delimiter: string): string {
  const rows = ["name", "description", "price", "colors"].join(delimiter);
  const results = catalog.results.map((result) =>
    [
      textCell(result.name, delimiter),
      textCell(result.description, delimiter),
      result.price.toFixed(2),
      textCell(result.colors?.join("; ") ?? "", delimiter),
    ].join(delimiter),
  );

  return `${[rows, ...results].join("\r\n")}\r\n`;
}

export function serializeCatalog(
  catalog: Catalog,
  options: { format?: OutputFormat; pretty?: boolean } = {},
): string {
  const { format = "json", pretty = false } = options;

  switch (format) {
    case "json":
      return `${JSON.stringify(catalog, null, pretty ? 2 : undefined)}\n`;
    case "csv":
      return serializeDelimited(catalog, ",");
    case "tsv":
      return serializeDelimited(catalog, "\t");
    default: {
      const unsupported: never = format;

      throw new Error(`Unsupported output format: ${unsupported}`);
    }
  }
}
