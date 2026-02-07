import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3333;
const CORPUS_DIR = process.env.CORPUS_DIR || join(process.cwd(), "corpus");

async function loadCorpus() {
  const files = (await readdir(CORPUS_DIR)).filter(f => f.endsWith(".txt") || f.endsWith(".md"));
  const docs = [];
  for (const f of files) {
    const text = await readFile(join(CORPUS_DIR, f), "utf8");
    docs.push({ id: f, title: f, text });
  }
  return docs;
}

function simpleSearch(docs, q) {
  const query = q.toLowerCase();
  const hits = [];
  for (const d of docs) {
    const idx = d.text.toLowerCase().indexOf(query);
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(d.text.length, idx + query.length + 80);
      hits.push({ id: d.id, title: d.title, snippet: d.text.slice(start, end) });
    }
  }
  return hits;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const docs = await loadCorpus();

    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ query: q, results: q ? simpleSearch(docs, q) : [] }));
      return;
    }

    if (url.pathname === "/doc") {
      const id = url.searchParams.get("id");
      const doc = docs.find(d => d.id === id);
      if (!doc) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: doc.id, title: doc.title, text: doc.text }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown_route" }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server_error", message: String(e) }));
  }
});

server.listen(PORT, () => {
  console.log(`epstein-search-mcp (stub) listening on http://127.0.0.1:${PORT}`);
  console.log(`Corpus dir: ${CORPUS_DIR}`);
});
