// fetch-audio.mjs — 只下音频（原学类视频内容全在解说词里），比下 480p 视频快得多。
// 并发 N 路 yt-dlp，断点续传：已存在的音频跳过。
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO = join(HERE, "audio");
const PY = "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-video-understand\\.venv\\Scripts\\python.exe";

const CONC = Number(process.argv[2] || 4);
const LIMIT = Number(process.argv[3] || 0);
const videos = JSON.parse(await fsp.readFile(join(HERE, "videos.json"), "utf8"));
await fsp.mkdir(AUDIO, { recursive: true });

const todo = [];
for (const v of videos) {
  const hits = (await fsp.readdir(AUDIO)).filter((f) => f.startsWith(v.bvid + "."));
  if (hits.length === 0) todo.push(v);
}
const queue = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
console.log("待下载 " + queue.length + " / 共 " + videos.length + "，并发 " + CONC);

function dl(v) {
  return new Promise((res) => {
    const args = ["-m", "yt_dlp", "--no-playlist", "--no-warnings", "-f", "ba/b",
      "-o", join(AUDIO, "%(id)s.%(ext)s"),
      "https://www.bilibili.com/video/" + v.bvid + "/"];
    const t0 = Date.now();
    const p = spawn(PY, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.stdout.on("data", () => {});
    p.on("close", (code) => {
      res({ bvid: v.bvid, code, sec: ((Date.now() - t0) / 1000).toFixed(1), err: err.slice(-200) });
    });
  });
}

let i = 0, ok = 0, fail = [];
async function worker(id) {
  while (true) {
    const k = i++;
    if (k >= queue.length) return;
    const r = await dl(queue[k]);
    if (r.code === 0) { ok++; console.log("[" + (ok + fail.length) + "/" + queue.length + "] ok " + r.bvid + " " + r.sec + "s"); }
    else { fail.push(r.bvid); console.log("[" + (ok + fail.length) + "/" + queue.length + "] FAIL " + r.bvid + " " + r.err); }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, (_, n) => worker(n)));
const files = (await fsp.readdir(AUDIO)).filter((f) => !f.endsWith(".part"));
let mb = 0;
for (const f of files) mb += (await fsp.stat(join(AUDIO, f))).size;
console.log("完成: 成功 " + ok + " 失败 " + fail.length + " 音频文件 " + files.length + " 个 " + (mb / 1048576).toFixed(1) + "MB，用时 " + ((Date.now() - t0) / 1000).toFixed(0) + "s");
if (fail.length) console.log("失败列表: " + fail.join(","));
