// import-video-kb.mjs — 把子代理写出的 entries/*.json 录入知识库。
// 复用 genshin-kb/import.mjs 的写入逻辑（与 dsh-tool-knowledge 的 store.add 完全一致）。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openKb, insertBatch, renderMarkdown } from "../genshin-kb/import.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRIES = join(HERE, "entries");
const PREFIX = "原学视频/";

function argVal(n, d) { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; }
const DB = argVal("--db", join(process.env.USERPROFILE || "", ".dsh", "knowledge", "kb.sqlite"));
const idFor = (k) => createHash("sha256").update(PREFIX + k).digest("hex").slice(0, 12);

await fsp.mkdir(ENTRIES, { recursive: true });
const all = (await fsp.readdir(ENTRIES)).filter((f) => f.endsWith(".json"));
const stated = [];
for (const f of all) stated.push([f, (await fsp.stat(join(ENTRIES, f))).mtimeMs]);
stated.sort((a, b) => a[1] - b[1]);
const files = stated.map((x) => x[0]);
// UP主名回填：子代理写条目时可能拿不到 UP 名（转写稿里没有），这里用 view API 取到的真实 UP 名补上
let OWNERS = {};
try { OWNERS = JSON.parse(await fsp.readFile(join(HERE, "owners.json"), "utf8")); } catch (e) {}
console.log("发现 " + files.length + " 个条目文件 -> " + DB);

const list = [];
const seen = new Set();
const bvSeen = new Set();
let skipped = 0;
for (const f of files) {
  let j;
  try { j = JSON.parse(await fsp.readFile(join(ENTRIES, f), "utf8")); }
  catch (e) { console.log("  !! 解析失败 " + f + ": " + e.message); skipped++; continue; }
  const items = Array.isArray(j) ? j : [j];
  for (const it of items) {
    const bvkey = it.bvid || f.replace(/\.json$/, "");
    if (bvSeen.has(bvkey)) { skipped++; continue; }   // 同一 BV 只收一份（重复处理时保留后写入的）
    bvSeen.add(bvkey);
    const e = it.entry || it;
    const key = (it.title || e.title || f).replace(PREFIX, "");
    if (!e.title || !e.problem || !e.solution) { console.log("  !! 字段不全 " + f); skipped++; continue; }
    const id = idFor(key);
    if (seen.has(id)) { skipped++; continue; }
    seen.add(id);
    // UP主回填：子代理写条目时转写稿里没有 UP 名，这里用 view API 取到的真实 UP 名补上
    let problem = String(e.problem);
    const owner = OWNERS[it.bvid || ""] || "";
    if (owner && /UP主[：:]\s*(佚名|未知|不详|$)/.test(problem)) problem = problem.replace(/UP主[：:]\s*(佚名|未知|不详)/, "UP主：" + owner);
    list.push({
      id: id,
      title: e.title.startsWith(PREFIX) ? e.title : PREFIX + e.title,
      problem: problem.slice(0, 4000),
      solution: String(e.solution),
      tags: Array.isArray(e.tags) ? e.tags.join(",") : String(e.tags || ""),
      source: e.source || ("原学视频(bilibili):https://www.bilibili.com/video/" + (it.bvid || "") + "/"),
      rawTitle: key,
    });
  }
}

if (list.length === 0) { console.log("没有可录入的条目"); process.exit(0); }
const kb = openKb(DB);
const entriesDir = join(dirname(DB), "entries");
await fsp.mkdir(entriesDir, { recursive: true });
insertBatch(kb, list, { ftsCap: 6000, bodyCap: 60000 });
const ts = Date.now();
for (const e of list) await fsp.writeFile(join(entriesDir, e.id + ".md"), renderMarkdown(e.id, e, ts), "utf8");
await fsp.appendFile(join(HERE, "manifest.tsv"), list.map((e) => e.id + "\t" + e.rawTitle + "\t" + e.source).join("\n") + "\n", "utf8");

console.log("录入 " + list.length + " 条（跳过 " + skipped + "），知识库总条目 " + kb.db.prepare("SELECT COUNT(*) n FROM entries").get().n);
for (const e of list) console.log("  [" + e.id + "] " + e.title);
