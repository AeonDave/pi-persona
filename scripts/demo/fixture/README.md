# acme-api

Background job queue behind the Acme HTTP API. `JobQueue` runs handlers with bounded
concurrency; `createApi` exposes submit, status and cancel to route handlers.
