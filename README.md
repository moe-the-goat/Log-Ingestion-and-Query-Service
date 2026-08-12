# Log Ingestion and Query Service

A service that ingests structured logs in batches, stores them in PostgreSQL, and makes them
searchable and aggregatable. PostgreSQL is the source of truth for both reads and writes.

## Quick start

```bash
docker compose up
```

The API listens on `http://localhost:8080`. It reports healthy only once the database connection
is up and migrations have been applied:

```bash
curl localhost:8080/health
```

## Local development

```bash
npm install
docker compose up postgres -d
npm run dev
```

## Endpoints

| Method | Path              | Purpose                  |
| ------ | ----------------- | ------------------------ |
| GET    | `/health`         | Readiness probe          |
| POST   | `/logs`           | Ingest a batch of logs   |
| GET    | `/logs`           | Query logs with filters  |
| GET    | `/logs/aggregate` | Time-bucketed log counts |

Full API documentation, schema and index design, retention strategy, and measured performance
results are documented below as those parts land.
