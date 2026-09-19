// export-github.mjs — 把知识库里本项目的条目导出成适合发布到 GitHub 的 Markdown 仓库结构。
// 注意：原神 wiki 的 19k 条只导出「标题索引」（原站内容版权归 biligame，不整体转载正文）。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "github-export");
const DB = join(homedir(), ".dsh", "knowledge", "kb.sqlite");

const db = new DatabaseSync(DB, { readOnly: true });
const all = db.prepare("SELECT id,title,problem,solution,tags,source,updated_at FROM entries").all();

function safeName(t) {
  return String(t).replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
}
function fm(e) {
  const tags = String(e.tags || "").split(",").filter(Boolean);
  return [
    "> **ID**：" + e.id,
    "> **标签**：" + tags.map((t) => t + "").join(" / "),
    "> **来源**：" + (e.source || ""),
    "",
    "## 摘要",
    "",
    String(e.problem || ""),
    "",
    "## 正文",
    "",
    String(e.solution || ""),
    "",
  ].join("\n");
}
async function writeGroup(subdir, rows, indexTitle, indexDesc) {
  const d = join(OUT, subdir);
  await fsp.mkdir(d, { recursive: true });
  const idx = ["# " + indexTitle, "", indexDesc, "", "共 " + rows.length + " 条。", ""];
  for (const e of rows.sort((a, b) => (a.title < b.title ? -1 : 1))) {
    const name = safeName(String(e.title).replace(/^[^\/]*\//, ""));
    await fsp.writeFile(join(d, name + ".md"), "# " + e.title + "\n\n" + fm(e), "utf8");
    idx.push("- [" + String(e.title).replace(/^[^\/]*\//, "") + "](" + encodeURI(subdir + "/" + name + ".md") + ")");
  }
  await fsp.writeFile(join(d, "_索引.md"), idx.join("\n"), "utf8");
  console.log("  " + subdir + ": " + rows.length + " 条");
  return rows.length;
}

await fsp.rm(OUT, { recursive: true, force: true });
await fsp.mkdir(OUT, { recursive: true });

const videos = all.filter((e) => String(e.source).startsWith("原学视频"));
const analysisV = videos.filter((e) => String(e.title).indexOf("主题·") >= 0 || String(e.title).indexOf("总索引") >= 0);
const singleV = videos.filter((e) => analysisV.indexOf(e) < 0);
const manual = all.filter((e) => String(e.source).startsWith("日月全事"));
const kaozheng = all.filter((e) => String(e.title).startsWith("考证/") || String(e.title).startsWith("补证/"));
const summary = all.filter((e) => String(e.title).startsWith("综述/"));
const wiki = all.filter((e) => String(e.source).startsWith("原神wiki"));

console.log("导出：");
const n1 = await writeGroup("knowledge/lore-videos", singleV, "原学视频知识库", "B站《原神》原学视频的逐集结构化分析。每条含核心论点、关键论据、涉及的游戏内设定与现实原型，以及作者自述推测的单独分节。");
const n2 = await writeGroup("knowledge/analysis", analysisV.concat(summary), "综合分析与跨视频主题", "跨视频主题归纳，以及整合全部四类来源的完整综合分析综述。");
const n3 = await writeGroup("knowledge/genshinlore-manual", manual, "《日月全事》原神世界观手册整理", "对 genshinlore.cn《日月全事》手册的逐章结构化整理。**本目录内容源自《日月全事》，详见 CREDITS.md 的署名要求。**");
await writeGroup("knowledge/kaozheng", kaozheng, "考证与争议对照（含补证）", "多来源冲突的对照与推理，以及反爬打通后的 14 条补证。**有分歧的地方保留分歧**，不强行二选一。");

// wiki 只导标题索引
const byCat = {};
for (const e of wiki) {
  const t = String(e.title).replace(/^原神wiki\//, "");
  let k = "其他";
  const m = String(e.tags).match(/角色|武器|怪物|材料|食物|任务|道具|书籍|NPC|成就|活动|圣遗物/);
  if (m) k = m[0];
  (byCat[k] = byCat[k] || []).push(t);
}
const wi = ["# biligame《原神》WIKI 条目标题索引", "",
  "本项目在本地建立了一份 biligame《原神》WIKI 的完整离线镜像（共 " + wiki.length + " 条正文条目），可按需检索。",
  "**出于版权考虑，本仓库只发布标题索引，不转载正文。** 正文版权归 [biligame 原神WIKI](https://wiki.biligame.com/ys/) 所有。", ""];
for (const k of Object.keys(byCat).sort((a, b) => byCat[b].length - byCat[a].length)) {
  wi.push("## " + k + "（" + byCat[k].length + "）", "");
  wi.push(byCat[k].sort().join("、"));
  wi.push("");
}
await fsp.mkdir(join(OUT, "knowledge"), { recursive: true });
await fsp.writeFile(join(OUT, "knowledge", "wiki-索引.md"), wi.join("\n"), "utf8");
console.log("  knowledge/wiki-索引.md: " + wiki.length + " 个标题");

const total = all.length;
const stat = [
  "# 数据统计", "",
  "| 类别 | 条数 |", "|---|---|",
  "| 原神 wiki 正文条目（本地镜像，仅发布索引） | " + wiki.length + " |",
  "| 原学视频逐集分析 | " + singleV.length + " |",
  "| 原学视频跨视频主题分析 | " + analysisV.length + " |",
  "| 《日月全事》手册整理 | " + manual.length + " |",
  "| 考证与补证（多来源对照） | " + kaozheng.length + " |",
  "| 综合分析与综述 | " + summary.length + " |",
  "| **本仓库发布** | **" + (singleV.length + analysisV.length + manual.length + kaozheng.length + summary.length) + "** |",
  "| 知识库总条目（含其他） | " + total + " |", "",
].join("\n");
await fsp.writeFile(join(OUT, "knowledge", "数据统计.md"), stat, "utf8");
await fsp.writeFile(join(OUT, "STATS.json"), JSON.stringify({ wiki: wiki.length, videos: singleV.length, themes: analysisV.length, manual: manual.length, kaozheng: kaozheng.length, summary: summary.length, published: singleV.length + analysisV.length + manual.length + kaozheng.length + summary.length, total: total }, null, 1), "utf8");
console.log("完成 -> " + OUT);
