// post-export.mjs — 导出后补充 README/CREDITS/工具脚本（export 会清空目录）
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "github-export");
const kbSet = new Set(["crawl.mjs", "clean.mjs", "import.mjs", "index.mjs", "verify.mjs", "inventory.mjs", "analyze.mjs"]);
const list = ["crawl.mjs", "clean.mjs", "import.mjs", "index.mjs", "verify.mjs", "inventory.mjs", "analyze.mjs",
  "fetch-audio.mjs", "asr.py", "glossary.py", "import-video-kb.mjs", "import-website-kb.mjs", "import-generic-kb.mjs",
  "prompt-template.txt", "website-prompt-template.txt", "kaozheng-prompt-template.txt", "export-github.mjs", "post-export.mjs"];
for (const f of ["README.md", "CREDITS.md"]) {
  await fsp.copyFile(join(HERE, "repo-assets", f), join(OUT, f));
}
await fsp.mkdir(join(OUT, "tools", "genshin-kb"), { recursive: true });
await fsp.mkdir(join(OUT, "tools", "genshin-video-kb"), { recursive: true });
let n = 0;
for (const f of list) {
  const isKb = kbSet.has(f);
  const src = isKb ? join(HERE, "..", "genshin-kb", f) : join(HERE, f);
  const dst = join(OUT, "tools", isKb ? "genshin-kb" : "genshin-video-kb", f);
  try { await fsp.copyFile(src, dst); n++; } catch (e) {}
}
await fsp.copyFile(join(HERE, "repo-assets", "tools-README.md"), join(OUT, "tools", "README.md"));
// 抓取工具也一并发布（反爬处理是本项目的重要组成）
await fsp.mkdir(join(OUT, "tools", "fetch-any"), { recursive: true });
for (const f of ["fetch-any.mjs", "README.md"]) {
  try { await fsp.copyFile(join(HERE, "..", "fetch-any", f), join(OUT, "tools", "fetch-any", f)); } catch (e) {}
}
console.log("post-export: README/CREDITS + " + n + " 个工具脚本");
