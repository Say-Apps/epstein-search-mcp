#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, basename } from "node:path";

const BASE = process.env.EPSTEIN_SEARCH_URL || "http://127.0.0.1:3333";
const TOKEN = process.env.EPSTEIN_ADMIN_TOKEN || "";

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir);
  for (const e of entries) {
    const p = join(dir, e);
    const st = await stat(p);
    if (st.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

function guessTitle(path) {
  return basename(path);
}

async function extractText(path) {
  const ext = extname(path).toLowerCase();
  if ([".txt", ".md", ".html", ".htm", ".json"].includes(ext)) {
    return await readFile(path, "utf8");
  }
  // Placeholder for PDFs/DOCs: next iteration add real extractors.
  return null;
}

async function upsert(doc) {
  const r = await fetch(`${BASE}/admin/upsert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": TOKEN,
    },
    body: JSON.stringify(doc),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Upsert failed ${r.status}: ${t}`);
  return t;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: EPSTEIN_SEARCH_URL=... EPSTEIN_ADMIN_TOKEN=... node tools/ingest.mjs <dir>");
    process.exit(2);
  }
  if (!TOKEN) {
    console.error("Missing EPSTEIN_ADMIN_TOKEN");
    process.exit(2);
  }
  const files = await walk(dir);
  let ok = 0, skipped = 0;
  for (const f of files) {
    const text = await extractText(f);
    if (text == null) { skipped++; continue; }
    const id = f.replace(dir, "").replace(/^\//, "");
    const doc = {
      id,
      title: guessTitle(f),
      text,
      meta: { path: f },
    };
    await upsert(doc);
    ok++;
  }
  console.log(JSON.stringify({ ok, skipped, total: files.length }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
