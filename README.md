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

## Worker (Cloudflare)

See `./worker/README.md`.

## HTTP API (common)

- `GET /health`
- `GET /search?q=<query>`
- `GET /doc?id=<filename>`
