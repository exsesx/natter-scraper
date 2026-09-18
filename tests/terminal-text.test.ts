import { expect, test } from "bun:test";
import { fitText, safeText, wrapText } from "../src/terminal-text";

test("source control characters cannot become terminal instructions", () => {
  const text = safeText("A\r\nB\rC\t\u001b[31mred\u001b[0m\u0000\u202e");

  expect(text).toBe("A\nB\nC    �[31mred�[0m��");
});

test("table cells truncate at display columns and flatten source newlines", () => {
  expect(fitText("界界界", 5)).toBe("界界…");
  expect(fitText("A\nB", 3)).toBe("A B");
  expect(fitText("long", 1)).toBe("…");
  expect(fitText("text", 0)).toBe("");
});

test("wrapping preserves graphemes and explicit blank lines", () => {
  const lines = wrapText("A👩‍💻é界B\n\nC", 4);

  expect(lines).toEqual(["A👩‍💻é", "界B", "", "C"]);
  expect(lines.every((line) => Bun.stringWidth(line) <= 4)).toBe(true);
});

test("compact JSON wraps without losing characters or overflowing the viewport", () => {
  const json = '{"name":"A long product name","price":12.34}';
  const lines = wrapText(json, 8);

  expect(lines.length).toBeGreaterThan(1);
  expect(lines.join("")).toBe(json);
  expect(lines.every((line) => Bun.stringWidth(line) <= 8)).toBe(true);
});

test("a one-column viewport safely substitutes wide glyphs", () => {
  expect(wrapText("界😀x", 1)).toEqual(["�", "�", "x"]);
  expect(wrapText("", 0)).toEqual([""]);
});
