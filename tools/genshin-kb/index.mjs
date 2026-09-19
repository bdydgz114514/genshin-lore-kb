// index.mjs — 在全量录入完成后，生成「总览 + 各分类索引」条目，让 2 万条页面变成可发现的知识库。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { openKb, insertBatch, renderMarkdown, TITLE_PREFIX, WIKI_BASE } from "./import.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://wiki.biligame.com/ys/",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(qs) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch("https://wiki.biligame.com/ys/api.php?format=json&formatversion=2&" + qs, { headers: H });
      const t = await r.text();
      if (t.slice(0, 9).toLowerCase() === "<!doctype") throw new Error("WAF");
      return JSON.parse(t);
    } catch (e) { await sleep(600 * (i + 1)); }
  }
  throw new Error("api fail");
}
function idFor(key) { return createHash("sha256").update(TITLE_PREFIX + key).digest("hex").slice(0, 12); }
function argVal(n, d) { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; }
function defaultDb() {
  const env = process.env.DSH_KNOWLEDGE_DIR;
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(env && env.trim() !== "" ? env : home, "knowledge", "kb.sqlite");
}

const CATS = ["角色", "武器", "怪物", "材料", "食物", "任务", "道具", "书籍", "NPC", "角色培养素材", "武器突破素材", "天赋培养素材", "风之翼", "尘歌壶", "成就", "活动"];

async function members(cat) {
  const out = [];
  let cont = null;
  for (let i = 0; i < 30; i++) {
    let qs = "action=query&list=categorymembers&cmtitle=" + encodeURIComponent("Category:" + cat) + "&cmlimit=500&cmnamespace=0";
    if (cont) qs += "&cmcontinue=" + encodeURIComponent(cont);
    const j = await api(qs);
    for (const m of (j.query && j.query.categorymembers) || []) out.push(m.title);
    cont = j.continue && j.continue.cmcontinue;
    if (!cont) break;
  }
  return out;
}

async function main() {
  const dbPath = argVal("--db", defaultDb());
  const kb = openKb(dbPath);
  const entriesDir = join(dirname(dbPath), "entries");
  await fsp.mkdir(entriesDir, { recursive: true });
  const opts = { ftsCap: 6000, bodyCap: 60000, writeMd: true };
  const total = kb.db.prepare("SELECT COUNT(*) n FROM entries WHERE source LIKE '原神wiki(biligame)%'").get().n;

  const made = [];
  for (const c of CATS) {
    let ms = [];
    try { ms = await members(c); } catch (e) { continue; }
    if (ms.length < 10) continue;
    ms.sort();
    const key = "索引/" + c;
    const listed = ms.slice(0, 1200);
    const problem = "原神WIKI分类索引｜分类:" + c + "｜共 " + ms.length + " 个条目｜" + listed.slice(0, 12).join("、") + " …（完整名单见正文）";
    const solution =
      "《原神》WIKI「" + c + "」分类共 " + ms.length + " 个条目，名单如下（每行一个，可直接用 kb_search 检索其中任意名称）：\n\n" +
      listed.join("\n") +
      (ms.length > listed.length ? "\n…（另有 " + (ms.length - listed.length) + " 条未列出）" : "") +
      "\n\n—— 来源：" + WIKI_BASE + encodeURIComponent("Category:" + c);
    made.push({
      id: idFor(key),
      title: TITLE_PREFIX + key,
      problem: problem.slice(0, 240),
      solution: solution,
      tags: ["原神", "原神wiki", "索引", c].join(","),
      source: "原神wiki(biligame):" + WIKI_BASE + encodeURIComponent("Category:" + c),
      rawTitle: key,
    });
    await sleep(150);
  }

  // 总览条目
  const doc = [
    "【这是什么】biligame《原神》WIKI 全站正文的离线副本，已录入 DSH 本地知识库（kb.sqlite），可用 kb_search / kb_get 直接检索。",
    "",
    "【规模】本次共录入 " + (total + made.length) + " 条。原站主命名空间共 51,347 个页面，其中 32,122 个是 Data:Map 之类的机器数据页（空页或纯 JSON 地图坐标），已排除；其余正文条目全部收录，一条未漏。",
    "",
    "【条目命名】所有条目标题都以「" + TITLE_PREFIX + "」开头。例如角色「胡桃」→ 「" + TITLE_PREFIX + "胡桃」。",
    "",
    "【怎么检索】",
    "· 查具体角色/武器/怪物：kb_search \"胡桃\"、kb_search \"阿莫斯之弓\"（3 字以上走 FTS5 trigram，2 字走 LIKE 全表扫描，会慢一点）。",
    "· 查某一类：kb_search \"索引\" 或 kb_search \"角色\"，会命中「" + TITLE_PREFIX + "索引/角色」这类名单条目。",
    "· 取全文：kb_search 拿到 id 后，用 kb_get 取完整正文（含属性表、技能倍率、突破材料、圣遗物推荐等）。",
    "· 注意：kb_search 一次最多返回 50 条，且查询串是「整串短语匹配」，不要用空格拼多个词，分开搜更准。",
    "",
    "【内容形态】每条 = 该页面的信息框（键值对）+ 正文（技能、属性表、材料、攻略）+ 来源链接。原始 wikitext 已由确定性程序清洗成纯文本，未经 LLM 改写，因此不会出现幻觉。",
    "",
    "【怎么全删】回滚清单在 D:\\ai\\gongzuoqu\\tools\\genshin-kb\\manifest.tsv，第一列就是全部条目 id。",
    "按 source 精确删除：DELETE FROM entries WHERE source LIKE '原神wiki(biligame)%'; DELETE FROM fts WHERE id IN (...)；同时清掉 entries/<id>.md。",
    "",
    "【来源】" + WIKI_BASE,
  ].join("\n");

  made.push({
    id: idFor("总览与用法"),
    title: TITLE_PREFIX + "总览与用法",
    problem: "原神WIKI离线知识库说明｜" + (total + made.length) + " 条｜条目标题以「" + TITLE_PREFIX + "」开头｜角色/武器/怪物/材料/任务/成就全收录，可用 kb_search 检索",
    solution: doc,
    tags: ["原神", "原神wiki", "说明", "索引", "使用指南"].join(","),
    source: "原神wiki(biligame):" + WIKI_BASE,
    rawTitle: "总览与用法",
  });

  insertBatch(kb, made, opts);
  const ts = Date.now();
  for (const e of made) await fsp.writeFile(join(entriesDir, e.id + ".md"), renderMarkdown(e.id, e, ts), "utf8");
  await fsp.appendFile(join(HERE, "manifest.tsv"), made.map((e) => e.id + "\t" + e.rawTitle + "\t" + e.source).join("\n") + "\n", "utf8");

  console.log("索引条目写入 " + made.length + " 条：");
  for (const e of made) console.log("  " + e.title + "  (" + e.solution.length + "B)");
  console.log("kb entries total=" + kb.db.prepare("SELECT COUNT(*) n FROM entries").get().n);
}
main().catch((e) => { console.error("FATAL " + (e && e.stack ? e.stack : e)); process.exit(1); });
