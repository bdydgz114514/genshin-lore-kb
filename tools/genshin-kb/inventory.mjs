// inventory.mjs — 枚举主命名空间全部页面（标题+字节数），用于分类统计。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://wiki.biligame.com/ys/api.php";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://wiki.biligame.com/ys/",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiJson(qs) {
  let last = null;
  for (let a = 0; a < 6; a++) {
    try {
      const res = await fetch(API + "?" + qs, { headers: HEADERS });
      const txt = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (txt.slice(0, 9).toLowerCase() === "<!doctype") throw new Error("WAF");
      return JSON.parse(txt);
    } catch (e) { last = e; await sleep(700 * (a + 1)); }
  }
  throw new Error("api failed: " + (last && last.message));
}

const all = [];
let cont = null;
for (let i = 0; i < 200; i++) {
  let qs = "action=query&generator=allpages&gaplimit=500&gapnamespace=0&gapfilterredir=nonredirects&prop=info&format=json&formatversion=2";
  if (cont) qs += "&gapcontinue=" + encodeURIComponent(cont);
  const j = await apiJson(qs);
  const pages = (j.query && j.query.pages) || [];
  for (const p of pages) all.push([p.title, p.length || 0]);
  cont = j.continue && j.continue.gapcontinue;
  if (i % 10 === 0) console.log("pages=" + all.length);
  if (!cont) break;
  await sleep(100);
}
all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
await fsp.writeFile(join(HERE, "inventory.json.gz"), gzipSync(Buffer.from(JSON.stringify(all), "utf8")));
console.log("TOTAL " + all.length + " pages; bytes=" + all.reduce((s, r) => s + r[1], 0));
