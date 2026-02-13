# Repository Guidelines

## Project Structure & Module Organization
This repository is currently in bootstrap state (no committed source tree yet). Keep the root minimal and use this layout as code is added:
- `src/`: application/plugin code, grouped by feature (example: `src/translation/`, `src/ui/`, `src/shared/`).
- `tests/`: mirrors `src/` paths for unit and integration tests.
- `assets/`: static files such as icons, locale data, and sample fixtures.
- `scripts/`: repeatable local/dev automation.
- Root config files: `package.json`, lint/format/test config, and CI files.

Prefer feature-oriented modules over large utility dumps. Keep files focused and avoid circular imports.

## Build, Test, and Development Commands
Use npm scripts as the single entrypoint for local workflows:
- `npm install`: install dependencies.
- `npm run dev`: start local development/watch mode.
- `npm run build`: create a production build artifact.
- `npm test`: run the full automated test suite.
- `npm run lint`: run static analysis.
- `npm run format`: apply code formatting.

If a script is added/renamed, update this file in the same PR.

## Coding Style & Naming Conventions
- Indentation: 2 spaces for JS/TS/JSON/Markdown.
- Prefer TypeScript for new logic modules.
- Naming: `kebab-case` for files, `PascalCase` for UI components/classes, `camelCase` for variables/functions.
- Keep public APIs explicit via named exports; avoid default exports in shared modules.
- Use ESLint + Prettier and keep lint warnings at zero before opening a PR.

## Testing Guidelines
- Framework baseline: Vitest for unit tests and Testing Library for UI behavior tests.
- Test file naming: `*.test.ts` or `*.test.tsx`.
- Target coverage: at least 80% lines on changed files; add regression tests for bug fixes.
- Run tests locally before pushing: `npm test`.

## Commit & Pull Request Guidelines
No project git history is available yet, so use Conventional Commits:
- `feat: add provider fallback`
- `fix: handle empty translation response`
- `chore: update lint config`

PRs should include:
- clear summary of behavior changes,
- linked issue/ticket (if applicable),
- test evidence (command output or CI link),
- screenshots/video for UI changes.

## Security & Configuration Tips
- Never commit secrets; use `.env.local` and keep `.env.example` updated.
- Review third-party translation/provider dependencies for license and data-handling constraints before adoption.
