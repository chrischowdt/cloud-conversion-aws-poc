# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Project Overview

**Cloud Migration Helper** – A Dynatrace App for assisting with cloud migration tasks. Built with React 18 + TypeScript using the Dynatrace App Toolkit (`dt-app`), running on Dynatrace AppEngine.

Currently in early development (scaffolded from the dt-app starter template).

## Commands

```bash
npm run start            # Dev server (hot reload)
npm run build            # Production build
npm run deploy           # Deploy to Dynatrace environment (configured in app.config.json)
npm run lint             # ESLint
npm run create:function  # Generate serverless function in api/
npm run create:action    # Generate action
```

## Architecture

```
ui/
├── main.tsx                 # Entry point, BrowserRouter with basename="ui"
├── app/
│   ├── App.tsx              # Route definitions (Page layout + Routes)
│   ├── pages/
│   │   ├── Home.tsx         # Welcome/landing page with resource cards
│   │   └── Data.tsx         # DQL query editor + timeseries chart
│   └── components/
│       ├── Header.tsx       # Navigation header (Home, Data links)
│       └── Card.tsx         # Reusable link card component
├── assets/                  # Logos and images
app.config.json              # Dynatrace app config (environment URL, scopes)
```

## MCP Tools

Use these MCP tools when working in this codebase:

- **`dynatrace-apps`** 
  - (`strato_search`, `strato_get_component`, `strato_get_usecase_details`): Look up Strato component props, usage examples, and patterns. **Always consult before using any Strato component.**
  - (`dql_search`): DQL query syntax, patterns, and examples. **Always consult before writing any DQL query.**

## Skills 
- **`dtctl`**: Execute DQL queries against live Dynatrace environments for validation. The app source code itself must not use dtctl for queries.

## Key Patterns

### Strato Component Imports

**Always** import from sub-packages, never from the root:

```tsx
// ✅ Correct
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading } from '@dynatrace/strato-components/typography';
import { DataTable } from '@dynatrace/strato-components-preview/tables';

// ❌ Wrong - causes bundle bloat
import { Flex, Heading } from '@dynatrace/strato-components';
```

**TypeScript definitions** live directly in the package under each component folder:
`node_modules/@dynatrace/strato-components[-preview]/<category>/<component>/<Component>.d.ts`
Always check `.d.ts` files there to understand APIs. Do NOT look for a separate `types/` subdirectory.

### DQL Data Fetching

Use `useDql` hook from `@dynatrace-sdk/react-hooks` in UI code. Prefer hooks over low-level clients (`@dynatrace-sdk/client-query`). See `ui/app/pages/Data.tsx` for reference:

```tsx
const { data, error, isLoading, cancel, refetch } = useDql({ query: queryString });
```

### Router Basename

BrowserRouter uses `basename="ui"` in `ui/main.tsx`. All routes are relative to `/ui/`.

### Tables

Prefer `DataTable` from `@dynatrace/strato-components/tables` for interactive tables (sorting, filtering, pagination). Use `SimpleTable` only for static/markdown content.

> **Note**: `DataTable` has graduated from preview to stable. `@dynatrace/strato-components-preview/tables` is a pure re-export and still works, but the canonical import is `@dynatrace/strato-components/tables`.

## Configuration

- **App config**: `app.config.json` — app name, ID, version, environment URL, and required scopes
- **Scopes**: Add permissions to the `scopes` array (e.g., `storage:logs:read`, `document:documents:read`)

## Common Tasks

- **Add Route**: Add `<Route>` in `ui/app/App.tsx` and a nav link in `ui/app/components/Header.tsx`
- **Query Data**: Use `useDql` hook with a DQL query string
- **Style Components**: Use design tokens from `@dynatrace/strato-design-tokens/{colors,borders,box-shadows}`

## Migration Notes

- **Log ingest migrates per connection, not per service.** Unlike metrics and entities (which are discovered and mapped per AWS/Azure/GCP service), log ingest is configured at the cloud account/connection level — typically via AWS Kinesis Firehose, Azure diagnostic settings/Event Hub, or GCP Pub/Sub. Log migration is a single step per cloud account and is deferred to a later phase.
