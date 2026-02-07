export interface Env {
  CORPUS: KVNamespace;
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

async function getDoc(env: Env, id: string) {
  const text = await env.CORPUS.get(id);
  if (text == null) return null;
  return { id, title: id, text };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ query: q, results: [] });

      const ids = await listDocIds(env);
      const results: Array<{ id: string; title: string; snippet: string }> = [];

      // Naive scan (OK for demo KV corpus sizes)
      for (const id of ids) {
        const text = await env.CORPUS.get(id);
        if (!text) continue;
        const s = snippet(text, q);
        if (s) results.push({ id, title: id, snippet: s });
        if (results.length >= 25) break;
      }

      return json({ query: q, results });
    }

    if (url.pathname === "/doc") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!id) return json({ error: "missing_id" }, 400);
      const doc = await getDoc(env, id);
      if (!doc) return json({ error: "not_found" }, 404);
      return json(doc);
    }

    if (url.pathname === "/admin/upsert" && req.method === "POST") {
      // Minimal admin for demo: upload docs into KV.
      // Auth: expects header X-Admin-Token matching ADMIN_TOKEN env var.
      const token = req.headers.get("x-admin-token") || "";
      const admin = (env as any).ADMIN_TOKEN as string | undefined;
      if (!admin || token !== admin) return json({ error: "unauthorized" }, 401);

      const body = await req.json().catch(() => null) as any;
      const id = body?.id;
      const text = body?.text;
      if (!id || typeof id !== "string" || typeof text !== "string") return json({ error: "invalid_body" }, 400);

      await env.CORPUS.put(id, text);

      const ids = new Set(await listDocIds(env));
      ids.add(id);
      await env.CORPUS.put("__index__", JSON.stringify([...ids]));

      return json({ ok: true, id });
    }

    return json({ error: "unknown_route" }, 404);
  },
};
