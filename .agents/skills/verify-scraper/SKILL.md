---
name: verify-scraper
description: Verify changes to scraper extraction, pricing, CLI output, terminal behavior, or standalone builds; use when checking an implementation change or preparing a handover.
---

# Verify the scraper

Identify the changed behavior from the task and relevant diff, then select the checks that cover it.

## Select the evidence

Read the output, CLI, and verification sections of [README.md](../../../README.md) for expected behavior and check commands. Read [source observations](../../../docs/source-behavior.md) when extraction, choices, or price rules are involved, and [the schema](../../../output.schema.json) when output shape changes.

## Choose checks

Run from the repository root with the pinned Bun version. Use the applicable rows together when a change spans multiple areas.

| Changed area | Checks |
| --- | --- |
| Extraction, pricing, HTTP, exports, or CLI behavior | `bun run check` |
| Terminal rendering, input, resize, or cancellation | `bun run check` and `bun run test:terminal` |
| Build configuration, bundled dependencies, or standalone behavior | `bun run check` and `bun run test:binary` |
| Full implementation handover | All three checks above |

For documentation-only changes, validate affected links and command names. See [distribution checks](../../../docs/distribution.md#verify-on-the-target-platform) for what the binary and terminal suites cover and their platform limits.

## Verify the changed behavior

- Prefer a small fixture catalog with an independently calculated expected output over repeated live crawls. A passing schema validator cannot establish catalog completeness or a correct total.
- For output changes, capture stdout and stderr separately in a subprocess. Verify exported bytes and exit status, including failure without a partial catalog and preservation of an existing output file.
- For interaction changes, exercise the README's TTY/CI/opt-out policy and completion-action availability. Inject desktop helpers in tests so they neither replace a user's clipboard nor open applications. Verify the actual Bun/Ink terminal lifecycle when rendering, input, or cleanup changes.
- For extraction changes, distinguish real source fixtures from synthetic cases. If live verification is needed and within the caller's scope, keep it bounded, record the URLs/date, and distinguish prices observed in the UI from prices derived from script evidence.

## Report

State which checks ran, their results, the OS/architecture tested, and what remains unverified. Distinguish fixture coverage from live-source evidence and successful cross-compilation from execution on the target platform.
