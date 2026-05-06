# Copilot Instructions

This file provides guidance to GitHub Copilot when working with code in this repository.
See `AGENTS.md` at the repository root for full project overview, architecture, commands, and patterns.

## Key Rules

- **Strato imports**: Always import from sub-packages (e.g., `@dynatrace/strato-components/layouts`), never the root. Use `dynatrace-apps` before using any Strato component.
- **DQL queries**: Use `dynatrace-apps` before writing any DQL. Use `useDql` hook in UI code. See `ui/app/pages/Data.tsx` for reference.
- **Routing**: BrowserRouter has `basename="ui"` in `ui/main.tsx`.
- **Live queries**: Use dtctl to run queries against Dynatrace environments for validation.