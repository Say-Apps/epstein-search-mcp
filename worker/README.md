# Cloudflare Workers deployment

This folder contains a Cloudflare Workers deployment of **epstein-search-mcp**.

It uses:
- **KV** for document index + metadata
- **R2** for full document text (avoids KV value-size limits)

## Deploy

1) Install wrangler
2) Login: `wrangler login`
3) Create a KV namespace and paste the id into `wrangler.toml`
4) Create an R2 bucket (must match `wrangler.toml`):
   - `wrangler r2 bucket create epstein-search`
5) `wrangler deploy`

## Storage layout

### KV
- `__index__` : JSON array of document ids
- `doc:<doc id>` : JSON metadata
  - `title`
  - `meta` (object)
  - `text_key` (R2 object key)

### R2
- `text/<doc id>.txt` : raw text
