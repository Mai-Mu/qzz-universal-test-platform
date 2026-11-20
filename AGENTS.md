# Repository Guidelines

## Project Structure

- `src/server.js` serves the Express API and static frontend. `src/mcp-server.mjs` exposes MCP tools over stdio. Shared SQLite schema, migrations, and package import logic live in `src/lib/`.
- `public/` holds the HTML, CSS, and browser ES modules. Put feature-specific UI code in `public/js/views/` and use `public/js/api.js` for API requests.
- `.agents/skills/` holds the bundled Codex skill. The MCP server reads the same `SKILL.md` to provide import guidance.
- `scripts/` holds the automated smoke tests. Deployment guides live in `docs/deployment/`, design notes live in `docs/design/`, and `deploy/` contains the Nginx configuration example.
- Keep project-specific test assets in the ignored `local-projects/` directory.

## Build, Test, and Development Commands

Use Node.js 24 to match the Docker image and run the built-in `node:sqlite` module.

- `npm ci` installs dependencies from `package-lock.json`.
- `npm start` serves the app at `http://localhost:3000` by default.
- `npm test` runs both smoke suites. Use `npm run test:web` or `npm run test:mcp` to run one suite.
- `docker build -t universal-test-platform:local .` builds the deployment image.

## Coding Style and Naming

Use two-space indentation, camelCase JavaScript names, and kebab-case CSS classes. Match the surrounding file’s quote style. Keep CommonJS in the Express server and `.cjs` libraries, and use ES modules in the browser and MCP entry point. Follow existing view names such as `projectCases.js` and smoke script names such as `mcp-smoke-test.mjs`.

## Testing Guidelines

Extend the relevant smoke script with `node:assert/strict` assertions for regressions. The Web suite checks JavaScript syntax, routing, report generation, and API behavior. The MCP suite exercises package validation, imports, and migration from a legacy SQLite schema. Run both suites for shared database changes. For manual checks with disposable data, set `TEST_PLATFORM_DATA_DIR` for Web or `TEST_PLATFORM_DB` for MCP, and set `TEST_PLATFORM_BACKUP_DIR` for either service.

## Commits and Pull Requests

Use a short imperative commit subject, following examples such as `Add cross-project home workbench`. In pull requests, describe the user-visible change and how you verified it. Link the issue when available and include screenshots for UI changes. Keep local `.env` files, SQLite databases, and backups out of commits.
