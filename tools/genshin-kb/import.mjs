// import.mjs — 把抓取到的 wikitext 确定性清洗后录入 DSH 本地知识库。
// 直接操作 kb.sqlite（entries + FTS5 + entries/<id>.md 镜像），与 dsh-tool-knowledge 的
// store.add() 写入格式完全一致，因此 kb_search / kb_get / kb_list 立即可用。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { cleanWikitext, extractCategories, firstInfobox, buildAbstract } from "./clean.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "raw");
export const WIKI_BASE = "https://wiki.biligame.com/ys/";
export const TITLE_PREFIX = "原神wiki/";

/* ---------------- 条目构造 ---------------- */

export function pageUrl(title) {
  return WIKI_BASE + encodeURIComponent(title.replace(/ /g, "_"));
}

export function stableId(title) {
  return createHash("sha256").update(TITLE_PREFIX + title).digest("hex").slice(0, 12);
}

export function buildEntry(row, opts) {
  const title = row.title;
  const wt = row.wt || "";
  const ctx = { title: title };
  const cats = extractCategories(wt);
  const info = firstInfobox(wt, ctx);
  let body = cleanWikitext(wt, title);

  if (body.length > opts.bodyCap) body = body.slice(0, opts.bodyCap) + "\n…（本条目过长，已截断，完整内容见来源页面）";

  const url = pageUrl(title);
  let problem = buildAbstract(cats, info, body, title);
  if (problem === "") problem = "分类:占位页｜该页面正文内容为空（可能是列表页、数据页或待补充条目），仅登记标题以便检索：" + title;

  const solution = (body === "" ? "（该页面在原站没有可提取的正文文本。）" : body) + "\n\n—— 来源：" + url;

  const tags = ["原神", "原神wiki", "游戏资料"];
  for (const c of cats) if (tags.indexOf(c) < 0) tags.push(c);
  if (tags.length > 14) tags.length = 14;

  return {
    id: stableId(title),
    title: TITLE_PREFIX + title,
    problem: problem,
    solution: solution,
    tags: tags.join(","),
    source: "原神wiki(biligame):" + url,
    rawTitle: title,
    cleanLen: body.length,
  };
}

/* ---------------- 知识库写入 ---------------- */

export function openKb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 20000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, title TEXT NOT NULL, problem TEXT, solution TEXT, tags TEXT, source TEXT, created_at INTEGER, updated_at INTEGER)");
  let fts = true;
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, title, problem, solution, tags, tokenize='trigram')");
  } catch (e) { fts = false; }
  return { db: db, fts: fts };
}

export function renderMarkdown(id, entry, ts) {
  const tags = String(entry.tags || "").split(",").filter((x) => x !== "");
  return [
    "# " + String(entry.title || ""),
    "",
    "- id: " + id,
    "- tags: " + tags.join(", "),
    "- updated: " + new Date(ts).toISOString(),
    entry.source ? "- source: " + entry.source : "",
    "",
    "## 问题现象",
    "",
    String(entry.problem || ""),
    "",
    "## 解决办法",
    "",
    String(entry.solution || ""),
    "",
  ].filter((x) => x !== "").join("\n");
}

// 与 dsh-tool-knowledge 的 store.add 行为一致：主表 upsert、fts 删后插、md 镜像落盘。
export function insertBatch(kb, list, opts) {
  const now = Date.now();
  const up = kb.db.prepare("UPDATE entries SET title=?, problem=?, solution=?, tags=?, source=?, updated_at=? WHERE id=?");
  const ins = kb.db.prepare("INSERT INTO entries (id,title,problem,solution,tags,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
  const delF = kb.db.prepare("DELETE FROM fts WHERE id = ?");
  const insF = kb.db.prepare("INSERT INTO fts (id,title,problem,solution,tags) VALUES (?,?,?,?,?)");
  kb.db.exec("BEGIN");
  try {
    for (const e of list) {
      const exists = kb.db.prepare("SELECT id FROM entries WHERE id = ?").get(e.id);
      if (exists) up.run(e.title, e.problem, e.solution, e.tags, e.source, now, e.id);
      else ins.run(e.id, e.title, e.problem, e.solution, e.tags, e.source, now, now);
      if (kb.fts) {
        try {
          delF.run(e.id);
          insF.run(e.id, e.title, e.problem, e.solution.slice(0, opts.ftsCap), e.tags);
        } catch (err) { /* fts 同步失败不影响主表 */ }
      }
    }
    kb.db.exec("COMMIT");
  } catch (err) {
    try { kb.db.exec("ROLLBACK"); } catch (e2) {}
    throw err;
  }
}

/* ---------------- CLI ---------------- */

function argVal(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
function argNum(name, dflt) {
  const v = Number(argVal(name, NaN));
  return Number.isFinite(v) ? v : dflt;
}

function defaultDb() {
  const env = process.env.DSH_KNOWLEDGE_DIR;
  if (env && env.trim() !== "") return join(env, "kb.sqlite");
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "knowledge", "kb.sqlite");
}

async function main() {
  const dbPath = argVal("--db", defaultDb());
  const bodyCap = argNum("--body-cap", 60000);
  const ftsCap = argNum("--fts-cap", 6000);
  const batchSize = argNum("--batch", 200);
  const limit = argNum("--limit", Infinity);
  const onlyRe = argVal("--only", null);
  const opts = { bodyCap: bodyCap, ftsCap: ftsCap, writeMd: process.argv.indexOf("--no-md") < 0 };

  const files = (await fsp.readdir(RAW)).filter((f) => f.endsWith(".json.gz")).sort();
  console.log("db=" + dbPath + " shards=" + files.length + " bodyCap=" + bodyCap + " ftsCap=" + ftsCap);

  const entriesDir = join(dirname(dbPath), "entries");
  await fsp.mkdir(entriesDir, { recursive: true });
  const kb = openKb(dbPath);
  const manifest = join(HERE, "manifest.tsv");

  let seen = 0, skipped = 0, imported = 0, chars = 0, maxClean = 0, emptyBody = 0;
  let pending = [];
  const t0 = Date.now();

  async function flush() {
    if (pending.length === 0) return;
    insertBatch(kb, pending, opts);
    if (opts.writeMd) {
      const ts = Date.now();
      await Promise.all(pending.map((e) => fsp.writeFile(join(entriesDir, e.id + ".md"), renderMarkdown(e.id, e, ts), "utf8")));
    }
    let man = "";
    for (const e of pending) man += e.id + "\t" + e.rawTitle + "\t" + e.source + "\n";
    await fsp.appendFile(manifest, man, "utf8");
    imported += pending.length;
    pending = [];
    if (imported % (batchSize * 10) === 0 || imported >= limit) {
      const el = (Date.now() - t0) / 1000;
      let mb = 0;
      try { mb = (await fsp.stat(dbPath)).size / 1048576; } catch (e) {}
      console.log("imported=" + imported + " skipped=" + skipped + " chars=" + (chars / 1048576).toFixed(1) + "MB db=" + mb.toFixed(1) + "MB " + el.toFixed(0) + "s " + (imported / el).toFixed(0) + "/s");
    }
  }

  outer:
  for (const f of files) {
    const rows = JSON.parse(gunzipSync(await fsp.readFile(join(RAW, f))).toString("utf8"));
    for (const row of rows) {
      seen++;
      if (/^Data:/.test(row.title)) { skipped++; continue; }
      if (onlyRe && row.title.indexOf(onlyRe) < 0) { skipped++; continue; }
      const e = buildEntry(row, opts);
      if (e.cleanLen === 0) emptyBody++;
      chars += e.solution.length;
      if (e.cleanLen > maxClean) maxClean = e.cleanLen;
      pending.push(e);
      if (pending.length >= batchSize) await flush();
      if (imported + pending.length >= limit) { await flush(); break outer; }
    }
  }
  await flush();

  const st = kb.db.prepare("SELECT COUNT(*) AS n FROM entries").get();
  let mb = 0;
  try { mb = (await fsp.stat(dbPath)).size / 1048576; } catch (e) {}
  console.log("=== DONE ===");
  console.log("pages seen=" + seen + " skipped(Data/filter)=" + skipped + " imported=" + imported);
  console.log("kb entries total=" + st.n + " db=" + mb.toFixed(1) + "MB chars=" + (chars / 1048576).toFixed(1) + "MB emptyBody=" + emptyBody + " maxClean=" + maxClean);
  console.log("elapsed=" + ((Date.now() - t0) / 1000).toFixed(0) + "s");
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/import.mjs")) {
  main().catch((e) => { console.error("FATAL " + (e && e.stack ? e.stack : e)); process.exit(1); });
}
