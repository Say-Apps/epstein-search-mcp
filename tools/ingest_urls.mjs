#!/usr/bin/env node
import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--retries") args.retries = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

const ARGS = parseArgs(process.argv);
if (ARGS.help) {
  console.log(
    "Usage: bun tools/ingest_urls.mjs urls.txt [--base https://... --token xxx --retries 4]\n" +
      "Env fallback: EPSTEIN_SEARCH_URL + EPSTEIN_ADMIN_TOKEN"
  );
  process.exit(0);
}

const BASE = ARGS.base || process.env.EPSTEIN_SEARCH_URL;
const TOKEN = ARGS.token || process.env.EPSTEIN_ADMIN_TOKEN;
if (!BASE || !TOKEN) {
  console.error(
    "Missing base/token. Provide --base/--token or set EPSTEIN_SEARCH_URL + EPSTEIN_ADMIN_TOKEN"
  );
  process.exit(2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, { retries = ARGS.retries ?? 4, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function upsert(doc) {
  return withRetry(async () => {
    const r = await fetch(`${BASE}/admin/upsert`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": TOKEN,
      },
      body: JSON.stringify(doc),
    });
    const t = await r.text();
    // Retry on transient errors.
    if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
      throw new Error(`Upsert transient ${r.status}: ${t}`);
    }
    if (!r.ok) throw new Error(`Upsert failed ${r.status}: ${t}`);
    return JSON.parse(t);
  });
}

async function fetchToFile(url, outPath) {
  return withRetry(async () => {
    const r = await fetch(url, { redirect: "follow" });
    if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
      throw new Error(`Fetch transient ${r.status} ${url}`);
    }
    if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    await writeFile(outPath, buf);
    return {
      contentType: r.headers.get("content-type") || "",
      finalUrl: r.url,
      bytes: buf.byteLength,
    };
  });
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
        const { r, bodyText } = await withRetry(async () => {
          const r = await fetch(url, { redirect: "follow" });
          if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
            throw new Error(`Fetch transient ${r.status} ${url}`);
          }
          if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
          return { r, bodyText: await r.text() };
        });
        contentType = r.headers.get("content-type") || "";
        finalUrl = r.url;
        text = bodyText;
      }

      if (!text || text.trim().length < 50) {
        skipped++;
        continue;
      }

      // Cloudflare KV has value size limits; keep a safe cap for now.
      const maxChars = 500_000;
      const originalChars = text.length;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
      }

      const resp = await upsert({
        id,
        title: id.split("/").slice(-1)[0] || id,
        text,
        meta: {
          source_url: finalUrl,
          fetched_at: new Date().toISOString(),
          content_type: contentType,
          original_chars: originalChars,
          truncated: originalChars > maxChars,
          stored_chars: text.length,
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
