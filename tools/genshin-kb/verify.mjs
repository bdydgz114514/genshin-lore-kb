// verify.mjs — 完全复刻 dsh-tool-knowledge 的 store.search()，离线验证录入结果可被检索。
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
function argVal(n, d) { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; }
function defaultDb() {
  const env = process.env.DSH_KNOWLEDGE_DIR;
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(env && env.trim() !== "" ? env : home, "knowledge", "kb.sqlite");
}
const dbPath = argVal("--db", defaultDb());
const db = new DatabaseSync(dbPath, { readOnly: true });

const total = db.prepare("SELECT COUNT(*) n FROM entries").get().n;
const ours = db.prepare("SELECT COUNT(*) n FROM entries WHERE source LIKE '原神wiki(biligame)%'").get().n;
console.log("kb.sqlite = " + dbPath);
console.log("entries 总数=" + total + "  其中原神wiki=" + ours + "  原有技术条目=" + (total - ours));

// 复刻 store.search 的两条查询路径
function search(q, limit) {
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 8;
  const t0 = Date.now();
  let rows;
  if (q.length >= 3) {
    try {
      rows = db.prepare("SELECT id, title, tags, substr(problem,1,240) AS snippet, updated_at FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?").all('"' + q.split('"').join('""') + '"', lim);
    } catch (e) { rows = null; }
  }
  if (!rows) {
    const like = "%" + q + "%";
    rows = db.prepare("SELECT id, title, tags, substr(problem,1,240) AS snippet, updated_at FROM entries WHERE title LIKE ? OR problem LIKE ? OR solution LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT ?").all(like, like, like, like, lim);
  }
  return { rows: rows, ms: Date.now() - t0, path: q.length >= 3 ? "FTS5" : "LIKE" };
}

const queries = process.argv.slice(2).filter((x) => x.indexOf("--") !== 0);
const list = queries.length > 0 ? queries : ["胡桃", "阿莫斯之弓", "元素反应", "圣遗物", "深渊", "突破材料", "夜兰", "原神wiki"];
for (const q of list) {
  const r = search(q, 5);
  console.log("\n=== kb_search(\"" + q + "\") 走 " + r.path + " | " + r.ms + "ms | 命中 " + r.rows.length);
  for (const h of r.rows) {
    console.log("  [" + h.id + "] " + h.title + "  {" + String(h.tags).slice(0, 46) + "}");
    console.log("      " + String(h.snippet).replace(/\n/g, " ").slice(0, 150));
  }
}
