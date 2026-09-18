---
name: verify-scraper
description: Verify changes to scraper extraction, pricing, CLI output, terminal behavior, or standalone builds; use when checking an implementation change or preparing a handover.
---

# Verify the scraper

Read the task and diff, then select checks for the changed behavior.

## Select the evidence

Use [README.md](../../../README.md) for the CLI/output contract, [source observations](../../../docs/source-behavior.md) for extraction or pricing, and [the schema](../../../output.schema.json) for JSON shape changes.

## Choose checks

Run from the repository root with the pinned Bun version. Combine applicable rows.

| Changed area | Checks |
| --- | --- |
| Extraction, pricing, HTTP, exports, or CLI behavior | `bun run check` |
| Terminal rendering, input, resize, or cancellation | `bun run check` and `bun run test:terminal` |
| Build configuration, bundled dependencies, or standalone behavior | `bun run check` and `bun run test:binary` |
| Full implementation handover | All three checks above |

For documentation-only changes, validate links, commands, and diagrams. See [distribution checks](../../../docs/distribution.md#verify-on-the-target-platform) for platform limits.

## Verify the changed behavior

- Use a small fixture catalog and independently calculated expected output. Schema validation alone cannot prove completeness or totals.
- For output changes, capture stdout/stderr separately. Check bytes, exit status, failure without partial output, and preservation of existing files.
- For interaction changes, exercise the README's TTY/CI/output policy and action availability in the Bun/Ink terminal. Inject desktop helpers so tests leave the clipboard and applications untouched.
- For extraction changes, distinguish captured source fixtures from synthetic cases. Keep any authorized live check bounded; record URLs/date and separate browser-observed prices from script-derived prices.

## Report

Report checks run, results, OS/architecture, and unverified areas. Distinguish fixtures from live evidence and cross-compilation from execution on the target platform.
