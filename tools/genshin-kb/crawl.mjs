// crawl.mjs — 抓取 biligame《原神》WIKI 主命名空间全部正文（不含重定向），按批次存 gzip 分片。
// 断点续传：crawl-state.json 保存 MediaWiki continue 令牌与已完成批次数。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "raw");
const STATE = join(HERE, "crawl-state.json");
const API = "https://wiki.biligame.com/ys/api.php";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://wiki.biligame.com/ys/",
};
const BATCH = 50; // MediaWiki 对 rvprop=content 的硬上限就是 50 页/请求

const argv = process.argv.slice(2);
function argNum(name, dflt) {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
const MAX_BATCHES = argNum("--max-batches", Infinity);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiJson(qs, tries) {
  tries = tries || 6;
  let last = null;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(API + "?" + qs, { headers: HEADERS });
      const txt = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (txt.slice(0, 9).toLowerCase() === "<!doctype") throw new Error("WAF html page");
      return JSON.parse(txt);
    } catch (e) {
      last = e;
      await sleep(700 * (a + 1));
    }
  }
  throw new Error("api failed after " + tries + " tries: " + (last && last.message));
}

function toQuery(params) {
  return Object.keys(params)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
}

async function saveState(st) {
  await fsp.writeFile(STATE, JSON.stringify(st, null, 1), "utf8");
}

async function main() {
  await fsp.mkdir(RAW, { recursive: true });
  let st = { batch: 0, pages: 0, cont: null, done: false, startedAt: new Date().toISOString() };
  try {
    st = Object.assign(st, JSON.parse(await fsp.readFile(STATE, "utf8")));
  } catch (e) {
    /* 首次运行 */
  }
  if (st.done) {
    console.log("already done: pages=" + st.pages + " batches=" + st.batch);
    return;
  }
  console.log("resume at batch=" + st.batch + " pages=" + st.pages);

  let sinceShard = 0;
  while (st.batch < MAX_BATCHES) {
    const params = {
      action: "query",
      generator: "allpages",
      gaplimit: BATCH,
      gapnamespace: 0,
      gapfilterredir: "nonredirects",
      prop: "revisions",
      rvprop: "content|timestamp",
      rvslots: "main",
      format: "json",
      formatversion: 2,
    };
    if (st.cont) Object.assign(params, st.cont);

    const j = await apiJson(toQuery(params));
    const pages = (j.query && j.query.pages) || [];
    const rows = pages.map((p) => ({
      pageid: p.pageid,
      title: p.title,
      ts: p.revisions && p.revisions[0] ? p.revisions[0].timestamp : null,
      wt: (p.revisions && p.revisions[0] && p.revisions[0].slots && p.revisions[0].slots.main && p.revisions[0].slots.main.content) || "",
    }));

    const name = "b-" + String(st.batch).padStart(5, "0") + ".json.gz";
    await fsp.writeFile(join(RAW, name), gzipSync(Buffer.from(JSON.stringify(rows), "utf8"), { level: 6 }));

    st.batch += 1;
    st.pages += rows.length;
    st.cont = j.continue || null;
    sinceShard += 1;
    if (sinceShard >= 4 || !st.cont) {
      sinceShard = 0;
      await saveState(st);
      console.log("batch=" + st.batch + " pages=" + st.pages + " cont=" + (st.cont ? "yes" : "no"));
    }
    if (!st.cont) {
      st.done = true;
      st.finishedAt = new Date().toISOString();
      await saveState(st);
      console.log("DONE pages=" + st.pages + " batches=" + st.batch);
      return;
    }
    await sleep(120);
  }
  await saveState(st);
  console.log("stopped at max-batches: batch=" + st.batch + " pages=" + st.pages);
}

main().catch(async (e) => {
  console.error("FATAL " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
