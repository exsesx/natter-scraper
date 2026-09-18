# Working in this repository

- Before changing behavior, read [README.md](README.md) for the CLI/output contract and [architecture](docs/architecture.md) for module responsibilities.
- Before changing extraction or pricing, read the [dated source evidence](docs/source-behavior.md) and verify the relevant live source. Samples do not establish full catalog coverage.
- Follow the [verification guide](.agents/skills/verify-scraper/SKILL.md) for extraction, output, terminal, or build changes. Report checks run for the current change and their limitations.
- Run package scripts from the repository root with the pinned Bun version and lockfile. Keep runtime dependencies limited to CLI, extraction, and desktop actions.

## Code readability

Separate logical steps with one blank line: between declarations and control flow, after a guard clause, and before a return following another statement. Keep related declarations together and guard clauses compact. A return-only block needs no leading blank line.

## Git conventions

Before committing, inspect the diff, run the required checks, and stage only requested changes. Repository workflows use standard Git commands and require no external skill.

Use Conventional Commits: `<type>[optional scope]: <imperative description>`, such as `fix(cli): preserve redirected output`. Mark breaking changes with `!` or a `BREAKING CHANGE` footer.

Publication and submission require an explicit user request.

## Agent tooling

`CLAUDE.md` and `.claude/skills` symlink to `AGENTS.md` and `.agents/skills/`. Keep one canonical copy; read it directly if a checkout does not preserve symlinks. Workflows must work without personal skills, plugins, or machine-specific paths.

Keep guidance focused on clone/run/test/change. Add skills only for repeated workflows; tests remain a core deliverable.
