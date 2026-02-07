#!/usr/bin/env node
import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BASE = process.env.EPSTEIN_SEARCH_URL;
const TOKEN = process.env.EPSTEIN_ADMIN_TOKEN;
if (!BASE || !TOKEN) {
  console.error("Missing EPSTEIN_SEARCH_URL or EPSTEIN_ADMIN_TOKEN");
  process.exit(2);
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
  return JSON.parse(t);
}

async function fetchToFile(url, outPath) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  await writeFile(outPath, buf);
  return {
    contentType: r.headers.get("content-type") || "",
    finalUrl: r.url,
    bytes: buf.byteLength,
  };
}

async function pdfToText(pdfPath) {
  // Requires poppler's pdftotext.
  const outPath = pdfPath.replace(/\.pdf$/i, ".txt");
  await execFileAsync("pdftotext", ["-layout", pdfPath, outPath]);
  return await readFile(outPath, "utf8");
}

function safeId(url) {
  // Turn URL into a stable KV-friendly id.
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._\/-]+/g, "-")
    .slice(0, 200);
}

async function main() {
  const listPath = process.argv[2];
  if (!listPath) {
    console.error("Usage: node tools/ingest_urls.mjs urls.txt");
    process.exit(2);
  }

  const urls = (await readFile(listPath, "utf8"))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const work = await mkdtemp(join(tmpdir(), "epstein-ingest-"));
  let ok = 0,
    fail = 0,
    skipped = 0;

  for (const url of urls) {
    try {
      const ext = extname(new URL(url).pathname).toLowerCase();
      const id = safeId(url);

      let text = "";
      let contentType = "";
      let finalUrl = url;

      if (ext === ".pdf") {
        const pdfPath = join(work, `${Math.random().toString(16).slice(2)}.pdf`);
        const meta = await fetchToFile(url, pdfPath);
        contentType = meta.contentType;
        finalUrl = meta.finalUrl;
        text = await pdfToText(pdfPath);
      } else {
        const r = await fetch(url, { redirect: "follow" });
        if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
        contentType = r.headers.get("content-type") || "";
        finalUrl = r.url;
        text = await r.text();
      }

      if (!text || text.trim().length < 50) {
        skipped++;
        continue;
      }

      const resp = await upsert({
        id,
        title: id.split("/").slice(-1)[0] || id,
        text,
        meta: {
          source_url: finalUrl,
          fetched_at: new Date().toISOString(),
          content_type: contentType,
        },
        // Bulk ingest safe defaults (can re-embed later in batches)
        embed: false,
        index_people: false,
      });

      ok++;
      process.stdout.write(
        `OK ${ok}: ${url} (semantic upserted: ${resp.semantic?.upserted ?? 0})\n`
      );
    } catch (e) {
      fail++;
      process.stdout.write(`FAIL ${fail}: ${url} :: ${String(e)}\n`);
    }
  }

  console.log(JSON.stringify({ ok, fail, skipped, total: urls.length }));
}

main();
