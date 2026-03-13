# epstein-search-mcp

Minimal MCP-style HTTP service for searching + serving a corpus of public documents.

This repo currently has **two runtimes**:
- **Local stub** (Node) — quick end-to-end wiring tests for the client/skill.
- **Cloudflare Worker** (Workers + KV) — deployable service.

> Note: The actual ingestion pipeline + “100 public docs” validation is tracked in the Open-source Skills Board task.

## Local stub (Node)

```bash
npm install
npm run dev
# http://127.0.0.1:3333/health
# http://127.0.0.1:3333/search?q=demo
# http://127.0.0.1:3333/doc?id=<filename>
```

## Bulk ingest helper

`tools/ingest_urls.mjs` can ingest a list of URLs into the service via the `/admin/upsert` endpoint.

## Quick validator (search → doc)

`tools/validate_search_docs.mjs` calls `/search` and then fetches `/doc?id=...` for the first N results to measure success rate + latency.

```bash
bun tools/validate_search_docs.mjs --base "https://<your-service>" --q epstein --n 15
```

It supports either env vars or CLI flags:

```bash
# Option A: env vars
export EPSTEIN_SEARCH_URL="https://<your-service>"
export EPSTEIN_ADMIN_TOKEN="<token>"

bun tools/ingest_urls.mjs ./epstein_urls_100.txt

# Option B: CLI flags (no env setup)
bun tools/ingest_urls.mjs ./epstein_urls_100.txt \
  --base "https://<your-service>" \
  --token "<token>" \
  --retries 4 \
  --concurrency 3
```

## Worker (Cloudflare)

See `./worker/README.md`.

## HTTP API (common)

- `GET /health`
- `GET /search?q=<query>`
- `GET /doc?id=<filename>`
