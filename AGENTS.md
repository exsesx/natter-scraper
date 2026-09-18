# Working in this repository

- Before changing scraper behavior, read `README.md` for the output and CLI contract and `docs/architecture.md` for module responsibilities.
- Before changing extraction or pricing, read `docs/source-behavior.md` and verify the relevant live source. Its observations are dated evidence, not a fixture set or a claim of full catalog coverage.
- When verifying extraction, totals, CLI output, or terminal behavior, follow the bundled [verification guide](.agents/skills/verify-scraper/SKILL.md). Read it directly if your agent does not support skills.
- Report checks actually executed for the current change and their limitations separately from earlier results.
- Run commands from the repository root using the pinned Bun version, lockfile, and package scripts. See `README.md` for setup; mise is optional. Keep runtime dependencies limited to CLI, extraction, and desktop actions.

## Code readability

Separate logical steps with one blank line: between a declaration group and control flow, after a guard clause, and before a return that follows another statement. Keep related declarations together and each guard clause compact. A block containing only a return needs no leading blank line. Preserve this spacing when editing code; readability matters more than minimizing line count.

## Git conventions

Before committing, inspect the working tree and relevant diff, run the checks required by the change, and stage only files within the requested scope. Use standard Git commands; no external skill is required.

Format subjects as `<type>[optional scope]: <imperative description>`. Use a meaningful type such as `docs`, `feat`, `fix`, `test`, `refactor`, `build`, `ci`, or `chore`; mark an actual breaking change with `!` or a `BREAKING CHANGE` footer. Example: `docs: record scraper implementation handover`.

Keep Git actions within the user's requested scope. Publication and submission require an explicit user request.

## Agent tooling

`AGENTS.md` and `.agents/skills/` contain the shared instructions. `CLAUDE.md` and `.claude/skills` are relative symlinks to them for Claude Code. If a checkout does not preserve symlinks, read the canonical files directly. Keep one copy of each instruction and skill; repository workflows must work without personal skills, plugins, or machine-specific paths.

Keep the documentation index, shared instructions, and one verification skill focused on the clone/run/test/change workflow. Add a skill only when a repeated workflow needs it. Tests remain a core deliverable.
