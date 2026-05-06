# Cloud Migration helper

Vision: Make it easy to understand what needs to be done for Dynatrace users to sucessfully migrate from classic cloud connections to new cloud connections within Dynatrace

Analyze and summarize all the objects (entites, telemetry signals, documents, alerts, settings) that rely on classic cloud connections. Provide a guide on how to migrate. Best case: automate migration (or parts of it)

## What it should do
 - Analyze DT environment: Scan and analyze your DT environment to understand what needs to be migratied
 - Browse & filter: List view with filtering and grouping possibility (cloud provider, cloud connection, data type, usage, migration difficulty)
 - Plan migration: Plan and recommend steps on how to migrate
 - (Optional:) Automate: Automatically execute (parts of the) migration steps

## Data Sources
Classic connections:
 - Entities
 - Metrics
 - Logs
 - Events
 - Traces

Dynatrace settings:
 - Alerts
 - Connection settings

Dynatrace documents:
 - Dashboards
 - Notebooks
 - Workflows
 - etc..
To be continued ...

This project was bootstrapped with Dynatrace App Toolkit.

It uses React in combination with TypeScript, to provide great developer experience.

## Quick Start

```bash
npm install
npm run start    # Development mode
npm run deploy   # Deploy to environment in app.config.json
npm run deploy   # Deploy to environment in app.config.cts
```

## Dynatrace tenants

To run or deploy the app on another tenant, copy `.env_template` to `.env` and set environment variable `DT_APP_ENVIRONMENT_URL`
accordingly.

e.g.

```
# dev self monitoring
DT_APP_ENVIRONMENT_URL=https://gmg80500.dev.apps.dynatracelabs.com/
```

## Learn more

[Dynatrace Developer](https://dt-url.net/developers)