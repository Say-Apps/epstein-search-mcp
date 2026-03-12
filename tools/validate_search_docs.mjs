#!/usr/bin/env node

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--q") args.q = argv[++i];
    else if (a === "--n") args.n = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

const ARGS = parseArgs(process.argv);
if (ARGS.help) {
  console.log(
    "Usage: bun tools/validate_search_docs.mjs --base https://<service> [--q epstein --n 15]\n" +
      "Checks /search then calls /doc for returned ids; prints success rate + latency stats."
  );
  process.exit(0);
}

const BASE = ARGS.base || process.env.EPSTEIN_SEARCH_URL;
if (!BASE) {
  console.error("Missing base. Provide --base or set EPSTEIN_SEARCH_URL");
  process.exit(2);
}

const q = ARGS.q || "epstein";
const n = Number.isFinite(ARGS.n) ? ARGS.n : 15;

function nowMs() {
  return Date.now();
}

function pctl(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

async function main() {
  const searchUrl = new URL(`${BASE.replace(/\/+$/, "")}/search`);
  searchUrl.searchParams.set("q", q);
  const t0 = nowMs();
  const sr = await fetch(searchUrl.toString());
  const sText = await sr.text();
  if (!sr.ok) throw new Error(`Search failed ${sr.status}: ${sText.slice(0, 200)}`);
  const searchJson = JSON.parse(sText);
  const results = Array.isArray(searchJson?.results) ? searchJson.results : [];
  const ids = results
    .map((r) => r?.id)
    .filter((id) => typeof id === "string" && id.length)
    .slice(0, n);

  console.log(`Search ok in ${(nowMs() - t0) / 1000}s. ids=${ids.length}/${results.length}`);

  let ok = 0,
    fail = 0;
  const lats = [];

  for (const id of ids) {
    const docUrl = new URL(`${BASE.replace(/\/+$/, "")}/doc`);
    docUrl.searchParams.set("id", id);
    const t1 = nowMs();
    const dr = await fetch(docUrl.toString());
    const dt = await dr.text();
    const dur = (nowMs() - t1) / 1000;
    lats.push(dur);

    if (!dr.ok) {
      fail++;
      console.log(`FAIL ${id} (${dur}s): ${dr.status} ${dt.slice(0, 120)}`);
      continue;
    }

    try {
      const j = JSON.parse(dt);
      const text = j?.text;
      if (typeof text !== "string" || text.trim().length < 50) {
        fail++;
        console.log(`FAIL ${id} (${dur}s): empty/short text`);
        continue;
      }
      ok++;
      console.log(`OK ${id} (${dur}s) chars=${text.length}`);
    } catch {
      fail++;
      console.log(`FAIL ${id} (${dur}s): non-JSON response`);
    }
  }

  lats.sort((a, b) => a - b);
  const summary = {
    ok,
    fail,
    total: ids.length,
    latency_s: {
      p50: pctl(lats, 0.5),
      p95: pctl(lats, 0.95),
      max: lats.length ? lats[lats.length - 1] : null,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
