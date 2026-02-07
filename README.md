# epstein-search-mcp (local stub)

Local-only stub server to validate end-to-end wiring (client/skill -> server) without shipping any dataset.

## Run

```bash
npm install
npm run dev
# http://127.0.0.1:3333/health
# http://127.0.0.1:3333/search?q=demo
```

## API

- `GET /health`
- `GET /search?q=<query>`
- `GET /doc?id=<filename>`
