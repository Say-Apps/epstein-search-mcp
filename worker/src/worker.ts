export interface Env {
  CORPUS: KVNamespace;
  VECTORIZE: any;
  AI: any;
  // Secret via `wrangler secret put ADMIN_TOKEN`
  ADMIN_TOKEN?: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function snippet(text: string, q: string) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + q.length + 100);
  return text.slice(start, end);
}

async function listDocIds(env: Env): Promise<string[]> {
  // Maintain a small index list in KV under key __index__ (JSON array)
  const raw = await env.CORPUS.get("__index__");
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function normalizeName(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function trigrams(s: string) {
  const t = normalizeName(s).replace(/[^a-z0-9\s]/g, "");
  const padded = `  ${t}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function extractPeopleHeuristic(text: string): string[] {
  // Heuristic: pick sequences of 2-3 capitalized words, filter obvious noise.
  // This is a placeholder until we do a proper NER pass in the ingest pipeline.
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cand = m[1];
    if (/^(The|This|That|These|Those)\b/.test(cand)) continue;
    out.add(cand);
  }
  return [...out];
}

function chunkText(text: string, maxLen = 800) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + maxLen);
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

async function getDoc(env: Env, id: string) {
  const raw = await env.CORPUS.get(`doc:${id}`);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === "string") {
      return { id, title: parsed.title || id, text: parsed.text, meta: parsed.meta || {} };
    }
  } catch {
    // fallthrough
  }
  // Backward compat: old layout stored raw text at key=id
  const text = await env.CORPUS.get(id);
  if (text == null) return null;
  return { id, title: id, text, meta: {} };
}

function isMcpPath(pathname: string) {
  return pathname === "/mcp/sse" || pathname === "/mcp/message";
}

function cors(res: Response) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type,x-admin-token");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}

function sse(headersInit: HeadersInit = {}) {
  const headers = new Headers(headersInit);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  headers.set("access-control-allow-origin", "*");
  return headers;
}

function sseEvent(data: unknown, event = "message") {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

async function mcpHandleRpc(env: Env, rpc: any) {
  const id = rpc?.id ?? null;
  const method = rpc?.method;
  const params = rpc?.params ?? {};

  // Minimal MCP-ish JSON-RPC surface.
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "epstein-search", version: "0.1.0" },
        capabilities: {
          tools: {},
        },
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "search",
            description: "Full-text search over ingested documents.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "number" } },
              required: ["query"],
            },
          },
          {
            name: "semantic_search",
            description: "Semantic search (embeddings via Workers AI, vectors in Vectorize) over chunked documents.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "number" } },
              required: ["query"],
            },
          },
          {
            name: "get_doc",
            description: "Fetch a document by id.",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
          {
            name: "people",
            description: "List documents associated with a person name.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" }, limit: { type: "number" } },
              required: ["name"],
            },
          },
        ],
      },
    };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "search") {
      const query = String(args?.query || "").trim();
      const limit = Math.max(1, Math.min(50, Number(args?.limit || 25)));
      const ids = await listDocIds(env);
      const results: Array<{ id: string; title: string; snippet: string }> = [];
      for (const docId of ids) {
        const doc = await getDoc(env, docId);
        if (!doc) continue;
        const s = query ? snippet(doc.text, query) : null;
        if (s) results.push({ id: docId, title: doc.title || docId, snippet: s });
        if (results.length >= limit) break;
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ query, results }, null, 2),
            },
          ],
        },
      };
    }

    if (name === "semantic_search") {
      const query = String(args?.query || "").trim();
      const limit = Math.max(1, Math.min(20, Number(args?.limit || 5)));
      if (!query) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } };

      const emb = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [query] });
      const vector = emb?.data?.[0];
      const r = await env.VECTORIZE.query(vector, { topK: limit, returnMetadata: true });
      const matches = (r?.matches || []).map((m: any) => ({ id: m.id, score: m.score, metadata: m.metadata }));

      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify({ query, matches }, null, 2) }] },
      };
    }

    if (name === "get_doc") {
      const docId = String(args?.id || "").trim();
      const doc = await getDoc(env, docId);
      if (!doc) {
        return { jsonrpc: "2.0", id, error: { code: -32004, message: "not_found" } };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
        },
      };
    }

    if (name === "people") {
      const person = String(args?.name || "").trim();
      const limit = Math.max(1, Math.min(100, Number(args?.limit || 50)));
      const key = `people:${normalizeName(person)}`;
      const raw = await env.CORPUS.get(key);
      const docIds: string[] = raw ? (JSON.parse(raw) as any) : [];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ name: person, results: docIds.slice(0, limit) }, null, 2),
            },
          ],
        },
      };
    }

    return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // Minimal MCP over SSE + POST (best-effort compatibility)
    if (isMcpPath(url.pathname)) {
      if (url.pathname === "/mcp/sse") {
        // Start SSE stream. We send a hello event. Client should then POST to /mcp/message.
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseEvent({ type: "hello", message: "epstein-search MCP endpoint" }, "message")));
          },
        });
        return new Response(stream, { headers: sse() });
      }
      if (url.pathname === "/mcp/message" && req.method === "POST") {
        const rpc = await req.json().catch(() => null);
        const resp = await mcpHandleRpc(env, rpc);
        return cors(json(resp));
      }
      return cors(json({ error: "mcp_bad_request" }, 400));
    }

    if (url.pathname === "/health") return cors(json({ ok: true, service: "epstein-search" }));

    if (url.pathname === "/") {
      return json({
        ok: true,
        routes: {
          health: "/health",
          search: "/search?q=...",
          doc: "/doc?id=...",
          people: "/people?name=...",
        },
      });
    }

    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ query: q, results: [] });

      const ids = await listDocIds(env);
      const results: Array<{ id: string; title: string; snippet: string }> = [];

      // Naive scan (OK for demo corpus sizes)
      for (const id of ids) {
        const doc = await getDoc(env, id);
        if (!doc) continue;
        const s = snippet(doc.text, q);
        if (s) results.push({ id, title: doc.title || id, snippet: s });
        if (results.length >= 25) break;
      }

      return json({ query: q, results });
    }

    if (url.pathname === "/semantic") {
      const q = (url.searchParams.get("q") || "").trim();
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit") || 5)));
      if (!q) return json({ query: q, matches: [] });

      const emb = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [q] });
      const vector = emb?.data?.[0];
      const r = await env.VECTORIZE.query(vector, { topK: limit, returnMetadata: true });
      const matches = [] as any[];
      for (const m of (r?.matches || [])) {
        const chunkText = await env.CORPUS.get(`chunk:${m.id}`);
        matches.push({ ...m, chunkText });
      }
      return json({ query: q, matches });
    }

    if (url.pathname === "/people") {
      const name = (url.searchParams.get("name") || "").trim();
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
      if (!name) return json({ name, results: [] });

      const normalized = normalizeName(name);
      const exactKey = `people:${normalized}`;
      const exactRaw = await env.CORPUS.get(exactKey);
      if (exactRaw) {
        const ids: string[] = JSON.parse(exactRaw) as any;
        const results: Array<{ id: string; title: string }> = [];
        for (const id of ids.slice(0, limit)) {
          const doc = await getDoc(env, id);
          if (doc) results.push({ id, title: doc.title || id });
        }
        return json({ name, normalized, match: { type: "exact", name: normalized, score: 1 }, results });
      }

      // Fuzzy name retrieval via trigram index
      const qTri = trigrams(normalized);
      const candidateNames = new Map<string, number>();
      for (const tri of qTri) {
        const raw = await env.CORPUS.get(`ng:${tri}`);
        if (!raw) continue;
        const names: string[] = JSON.parse(raw) as any;
        for (const n of names) candidateNames.set(n, (candidateNames.get(n) || 0) + 1);
      }

      const scored: Array<{ name: string; score: number }> = [];
      for (const n of candidateNames.keys()) {
        const s = jaccard(qTri, trigrams(n));
        if (s >= 0.25) scored.push({ name: n, score: s });
      }
      scored.sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best) return json({ name, normalized, match: { type: "none" }, suggestions: scored.slice(0, 10), results: [] });

      const key = `people:${best.name}`;
      const raw = await env.CORPUS.get(key);
      const ids: string[] = raw ? (JSON.parse(raw) as any) : [];
      const results: Array<{ id: string; title: string }> = [];
      for (const id of ids.slice(0, limit)) {
        const doc = await getDoc(env, id);
        if (doc) results.push({ id, title: doc.title || id });
      }

      return json({
        name,
        normalized,
        match: { type: "fuzzy", name: best.name, score: best.score },
        suggestions: scored.slice(0, 10),
        results,
      });
    }

    if (url.pathname === "/doc") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!id) return json({ error: "missing_id" }, 400);
      const doc = await getDoc(env, id);
      if (!doc) return json({ error: "not_found" }, 404);
      return json(doc);
    }

    if (url.pathname === "/admin/upsert" && req.method === "POST") {
      // Upload docs into KV. Auth: header X-Admin-Token must match ADMIN_TOKEN secret.
      const token = req.headers.get("x-admin-token") || "";
      const admin = env.ADMIN_TOKEN;
      if (!admin || token !== admin) return json({ error: "unauthorized" }, 401);

      const body = (await req.json().catch(() => null)) as any;
      const id = body?.id;
      const text = body?.text;
      const title = body?.title;
      const meta = body?.meta;
      const people = body?.people; // optional array of person names

      if (!id || typeof id !== "string" || typeof text !== "string") return json({ error: "invalid_body" }, 400);

      const docObj = {
        id,
        title: typeof title === "string" ? title : id,
        text,
        meta: meta && typeof meta === "object" ? meta : {},
      };

      await env.CORPUS.put(`doc:${id}`, JSON.stringify(docObj));

      const ids = new Set(await listDocIds(env));
      ids.add(id);
      await env.CORPUS.put("__index__", JSON.stringify([...ids]));

      const peopleList: string[] = Array.isArray(people)
        ? people.filter((p: any) => typeof p === "string")
        : extractPeopleHeuristic(text);

      for (const p of peopleList) {
        const norm = normalizeName(p);
        const k = `people:${norm}`;
        const existingRaw = await env.CORPUS.get(k);
        const existing = new Set<string>(existingRaw ? (JSON.parse(existingRaw) as any) : []);
        existing.add(id);
        await env.CORPUS.put(k, JSON.stringify([...existing]));

        // Trigram index: ng:<tri> -> [names]
        for (const tri of trigrams(norm)) {
          const ngKey = `ng:${tri}`;
          const ngRaw = await env.CORPUS.get(ngKey);
          const ngSet = new Set<string>(ngRaw ? (JSON.parse(ngRaw) as any) : []);
          ngSet.add(norm);
          await env.CORPUS.put(ngKey, JSON.stringify([...ngSet]));
        }
      }

      // Semantic chunks: embed + upsert into Vectorize; store chunk text in KV.
      let semantic = { chunks: 0, vectors: 0, upserted: 0, error: null as string | null };
      try {
        const chunks = chunkText(text, 800).slice(0, 40); // cap to keep costs sane
        semantic.chunks = chunks.length;
        const embeddings = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: chunks });
        const vectors = embeddings?.data || [];
        semantic.vectors = Array.isArray(vectors) ? vectors.length : 0;
        const upserts = [] as any[];
        for (let i = 0; i < chunks.length; i++) {
          const chunkId = `${id}::${i}`;
          const vec = vectors[i];
          if (!vec) continue;
          await env.CORPUS.put(`chunk:${chunkId}`, chunks[i]);
          upserts.push({
            id: chunkId,
            values: vec,
            metadata: { docId: id, title: docObj.title, i },
          });
        }
        if (upserts.length) {
          const r = await env.VECTORIZE.upsert(upserts);
          semantic.upserted = upserts.length;
        }
      } catch (e: any) {
        semantic.error = String(e?.message || e);
      }

      return json({ ok: true, id, people: peopleList.length, semantic });
    }

    return json({ error: "unknown_route" }, 404);
  },
};
