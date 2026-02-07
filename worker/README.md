# Cloudflare Workers deployment

This folder contains a Workers+KV deployment of epstein-search-mcp.

## Deploy

1) Install wrangler
2) Login: `wrangler login`
3) Create KV namespace and paste id into wrangler.toml
4) `wrangler deploy`

## KV layout

- `__index__` : JSON array of document ids
- `<doc id>` : raw text
