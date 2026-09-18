/** Escape source controls for display without changing the exported catalog. */
export function safeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "    ")
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, (character) =>
      character === "\n" ? "\n" : "�",
    );
}

export function fitText(value: string, width: number): string {
  if (width <= 0) return "";

  return Bun.sliceAnsi(safeText(value).replace(/\n/gu, " "), 0, width, {
    ellipsis: "…",
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Soft-wrap at terminal columns, including compact JSON and wide characters. */
export function wrapText(value: string, width: number): string[] {
  const columns = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  let used = 0;

  for (const { segment } of graphemes.segment(safeText(value))) {
    if (segment === "\n") {
      lines.push(line);
      line = "";
      used = 0;

      continue;
    }

    const size = Bun.stringWidth(segment);

    if (used + size > columns && line) {
      lines.push(line);
      line = "";
      used = 0;
    }

    // A single wide glyph cannot fit in a one-column viewport.
    line += size > columns ? "�" : segment;
    used += size > columns ? 1 : size;
  }

  lines.push(line);

  return lines;
}
