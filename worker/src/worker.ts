export interface Env {
  CORPUS: KVNamespace;
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json({ ok: true, service: "epstein-search" });

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

    if (url.pathname === "/people") {
      const name = (url.searchParams.get("name") || "").trim();
      if (!name) return json({ name, results: [] });
      const key = `people:${normalizeName(name)}`;
      const raw = await env.CORPUS.get(key);
      const ids: string[] = raw ? (JSON.parse(raw) as any) : [];
      const results: Array<{ id: string; title: string }> = [];
      for (const id of ids.slice(0, 50)) {
        const doc = await getDoc(env, id);
        if (doc) results.push({ id, title: doc.title || id });
      }
      return json({ name, results });
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
        const k = `people:${normalizeName(p)}`;
        const existingRaw = await env.CORPUS.get(k);
        const existing = new Set<string>(existingRaw ? (JSON.parse(existingRaw) as any) : []);
        existing.add(id);
        await env.CORPUS.put(k, JSON.stringify([...existing]));
      }

      return json({ ok: true, id, people: peopleList.length });
    }

    return json({ error: "unknown_route" }, 404);
  },
};
