// import-website-kb.mjs — 把《日月全事》整理出的 website-entries/*.json 录入知识库。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openKb, insertBatch, renderMarkdown } from "../genshin-kb/import.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, process.env.KB_SRC_DIR || "website-entries");
const PREFIX = process.env.KB_PREFIX || "日月全事/";
const CREDIT = process.env.KB_CREDIT || "本次输出的学习素材包括《日月全事》";

function argVal(n, d) { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; }
const DB = argVal("--db", join(process.env.USERPROFILE || "", ".dsh", "knowledge", "kb.sqlite"));
const MANIFEST = process.env.KB_MANIFEST || "manifest-website.tsv";
const SKIP_CREDIT = process.env.KB_SKIP_CREDIT === "1";
const idFor = (k) => createHash("sha256").update(PREFIX + k).digest("hex").slice(0, 12);

await fsp.mkdir(SRC, { recursive: true });
const files = (await fsp.readdir(SRC)).filter((f) => f.endsWith(".json")).sort();
console.log("发现 " + files.length + " 个网站条目文件 -> " + DB);

const list = [];
const seen = new Set();
let skipped = 0, noCredit = 0;
for (const f of files) {
  let j;
  try { j = JSON.parse(await fsp.readFile(join(SRC, f), "utf8")); }
  catch (e) { console.log("  !! 解析失败 " + f + ": " + e.message); skipped++; continue; }
  const items = Array.isArray(j) ? j : [j];
  for (const it of items) {
    const e = it.entry || it;
    if (!e.title || !e.problem || !e.solution) { console.log("  !! 字段不全 " + f); skipped++; continue; }
    const key = e.title.replace(PREFIX, "");
    const id = idFor(key);
    if (seen.has(id)) { skipped++; continue; }
    seen.add(id);
    let solution = String(e.solution);
    // 手册要求引用时署名，兜底补上
    if (!SKIP_CREDIT && solution.indexOf(CREDIT) < 0) {
      noCredit++;
      solution += "\n\n【来源署名】\n" + CREDIT + "\n任何经由人工智能工具产出的结论仅作参考，不代表《日月全事》观点";
    }
    list.push({
      id: id,
      title: e.title.startsWith(PREFIX) ? e.title : PREFIX + e.title,
      problem: String(e.problem).slice(0, 4000),
      solution: solution,
      tags: Array.isArray(e.tags) ? e.tags.join(",") : String(e.tags || ""),
      source: e.source || "日月全事(genshinlore.cn)",
      rawTitle: key,
    });
  }
}
if (list.length === 0) { console.log("没有可录入的条目"); process.exit(0); }
const kb = openKb(DB);
const entriesDir = join(dirname(DB), "entries");
await fsp.mkdir(entriesDir, { recursive: true });
insertBatch(kb, list, { ftsCap: 200000, bodyCap: 200000 });
const ts = Date.now();
for (const e of list) await fsp.writeFile(join(entriesDir, e.id + ".md"), renderMarkdown(e.id, e, ts), "utf8");
await fsp.appendFile(join(HERE, MANIFEST), list.map((e) => e.id + "\t" + e.rawTitle + "\t" + e.source).join("\n") + "\n", "utf8");
console.log("录入 " + list.length + " 条（跳过 " + skipped + "，自动补署名 " + noCredit + " 条），知识库总条目 " + kb.db.prepare("SELECT COUNT(*) n FROM entries").get().n);
for (const e of list) console.log("  [" + e.id + "] " + e.title + "  " + e.solution.length + "B");
