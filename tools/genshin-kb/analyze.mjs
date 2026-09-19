import { promises as fsp } from "node:fs";
import { gunzipSync } from "node:zlib";
const all = JSON.parse(gunzipSync(await fsp.readFile("inventory.json.gz")).toString("utf8"));
const total = all.length;
const bytes = all.reduce((s, r) => s + r[1], 0);

// 前缀分桶
const buckets = new Map();
for (const [t, n] of all) {
  let b;
  const c = t.indexOf(":");
  if (/^Data:Map\/point\//.test(t)) b = "Data:Map/point/*";
  else if (/^Data:/.test(t)) b = "Data:* 其他";
  else if (c > 0 && c <= 12 && !/[\u4e00-\u9fff]/.test(t.slice(0, c))) b = "疑似命名空间前缀:" + t.slice(0, c + 1);
  else b = "正文条目";
  const e = buckets.get(b) || { n: 0, bytes: 0 };
  e.n++; e.bytes += n;
  buckets.set(b, e);
}
const rows = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
console.log("TOTAL " + total + " pages, " + (bytes / 1048576).toFixed(1) + " MB wikitext\n");
console.log("桶".padEnd(28) + "页数".padStart(8) + "体积MB".padStart(10));
for (const [k, v] of rows.slice(0, 25)) console.log(k.padEnd(28) + String(v.n).padStart(8) + (v.bytes / 1048576).toFixed(1).padStart(10));
console.log("\n--- 非 Data 页面的体积分布 ---");
const real = all.filter((r) => !/^Data:/.test(r[0]));
const sz = real.map((r) => r[1]).sort((a, b) => a - b);
const q = (p) => sz[Math.floor(sz.length * p)] || 0;
console.log("真实条目数=" + real.length + " 总字节=" + (real.reduce((s, r) => s + r[1], 0) / 1048576).toFixed(1) + "MB");
console.log("min=" + sz[0] + " p25=" + q(0.25) + " p50=" + q(0.5) + " p75=" + q(0.75) + " p90=" + q(0.9) + " p99=" + q(0.99) + " max=" + sz[sz.length - 1]);
console.log("空页(<20B)=" + sz.filter((x) => x < 20).length + " 小页(<200B)=" + sz.filter((x) => x < 200).length + " 大页(>20KB)=" + sz.filter((x) => x > 20000).length);
console.log("\n--- 最大的 10 个真实条目 ---");
for (const r of real.slice().sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(String(r[1]).padStart(7) + "  " + r[0]);
