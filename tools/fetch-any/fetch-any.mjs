// fetch-any v2 —— 分级降级网页抓取器
//
// 核心认知：**拦截不是一个问题，是四个**，对策完全不同：
//   1. DNS 污染/被墙    -> 解析到 199.59.148.x 这类假 IP -> 代理，或 DoH 直连真 IP
//   2. Cloudflare 挑战  -> "Just a moment..." / "请稍候…" -> 无头浏览器也过不了，**改用它的 API 端点**
//   3. 服务端 403 风控  -> 403 且无 CF 特征 -> 真浏览器内核（实测 NGA / 百度百科有效）
//   4. JS 渲染 SPA      -> 200 但正文为空 -> 无头浏览器 --dump-dom
//
// 优先级顺序很重要：**先找官方 API，再考虑抓 HTML**。
// MediaWiki 系（Wikipedia / Fandom / 各类 wiki）的 api.php 几乎总是绕过 Cloudflare 和 WAF。

import { spawn, spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));

export const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};
const JSON_HEADERS = { "User-Agent": BROWSER_HEADERS["User-Agent"], Accept: "application/json" };

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/* ---------- 拦截判定 ---------- */

// 无头浏览器抓失败时会 dump 出 Chrome 自己的报错页，体积 300KB+，
// 只看字节数会把它判成成功 —— 这是本项目踩过的最贵的坑。
const CHROME_ERR_PAT = /(main-frame-error|Copyright 2017 The Chromium Authors|net::ERR_|error-code|neterror)/i;
// Cloudflare / 人机校验
// 注意：不要把裸的 "challenge-platform" 当特征 —— Cloudflare 会在**所有**代理站的正常页面
// 里注入 /cdn-cgi/challenge-platform/scripts/jsd/main.js，拿它做判据会把好页面误杀
// （实测 genshinlore.cn 的小页面因此被误判为拦截）。只认真正的挑战页interstitial特征。
const CHALLENGE_PAT = /(Just a moment|请稍候|Checking your browser before|cf-challenge-|cf-browser-verification|Enable JavaScript and cookies to continue)/i;
// 国内站常见风控页
const CN_BLOCK_PAT = /(访客不能直接访问|安全验证|访问异常|请开启\s*JavaScript|您的访问过于频繁|403 Forbidden|验证码)/i;

export function classifyBlock(status, body) {
  const head = String(body || "").slice(0, 8000);
  if (CHROME_ERR_PAT.test(head)) return "browser_error";
  if (CHALLENGE_PAT.test(head)) return "cloudflare";
  if (CN_BLOCK_PAT.test(head)) return "waf";
  if (status !== 200) return "http_" + status;
  if (head.length < 1500) return "too_small";
  return null;
}

/* ---------- DoH：不依赖 VPN 绕 DNS 污染 ---------- */

const DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.alidns.com/resolve",
  "https://doh.pub/dns-query",
];

export async function resolveDoh(hostname, timeoutMs = 8000) {
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  for (const ep of DOH_ENDPOINTS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(ep + "?name=" + encodeURIComponent(hostname) + "&type=A", { headers: { Accept: "application/dns-json" }, signal: ac.signal });
      const j = await r.json();
      clearTimeout(t);
      const a = (j.Answer || []).filter((x) => x.type === 1);
      if (a.length > 0) return { address: a[0].data, family: 4, via: ep };
    } catch (e) { clearTimeout(t); }
  }
  return null;
}

// 让 undici 用 DoH 的结果建连：绕过本地被污染的 DNS。
// 注意：只有当"封锁只在 DNS 层"时才有用；如果目标 IP 本身被 null route，仍然要代理。
async function loadUndici() {
  // Node 内建 fetch 不认 proxy/dns 选项，需要 undici。但它不是内建模块，
  // 没装就 import 失败 —— 必须兜住，否则整个进程崩掉（本项目踩过）。
  try { return await import("undici"); } catch (e) { return null; }
}

export async function dohAgent() {
  const u = await loadUndici();
  if (!u) return null;
  const { Agent } = u;
  return new Agent({
    connect: {
      lookup(hostname, opts, cb) {
        resolveDoh(hostname).then((r) => {
          if (!r) return cb(new Error("DoH 解析失败: " + hostname));
          cb(null, r.address, r.family);
        }).catch((e) => cb(e));
      },
    },
  });
}

/* ---------- 代理：读取系统设置 ---------- */

export function systemProxy() {
  const envP = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envP) return envP;
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"], { encoding: "utf8" });
    const m = String(r.stdout || "").match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!m) return null;
    let v = m[1];
    if (!/^https?:\/\//.test(v)) v = "http://" + v;
    return v;
  } catch (e) { return null; }
}

export async function proxyAgent() {
  const p = systemProxy();
  if (!p) return null;
  const u = await loadUndici();
  if (!u) return null;
  try { return new u.ProxyAgent(p); } catch (e) { return null; }
}

/* ---------- 官方 API 优先 ---------- */

// MediaWiki 系站点（Wikipedia / Fandom / 大多数 wiki）的 api.php 通常不经过
// Cloudflare 的人机校验，而 HTML 页面会。实测 Fandom：HTML 403 + "Just a moment"，
// 而 api.php 返回 200 与完整 wikitext。所以抓 wiki 一律先试 API。
export function isMediaWiki(url) {
  return /(wikipedia\.org|wikimedia\.org|fandom\.com|wiki\.|\.wiki\/|\/wiki\/)/i.test(url);
}
export function mediaWikiApiBase(url) {
  try {
    const u = new URL(url);
    if (/fandom\.com$/i.test(u.hostname)) return u.origin + "/api.php";
    if (/wikipedia\.org$/i.test(u.hostname)) return u.origin + "/w/api.php";
    return u.origin + "/api.php";
  } catch (e) { return null; }
}
export function pageTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/wiki\/(.+)$/);
    if (m) return decodeURIComponent(m[1]).replace(/_/g, " ");
    const q = u.searchParams.get("title");
    return q || null;
  } catch (e) { return null; }
}
export async function fetchViaMediaWikiApi(url, opts = {}) {
  const base = mediaWikiApiBase(url);
  const title = pageTitleFromUrl(url);
  if (!base || !title) return null;
  const api = base + "?action=parse&page=" + encodeURIComponent(title) + "&prop=wikitext&format=json&formatversion=2&redirects=1";
  const r = await rawFetch(api, { headers: JSON_HEADERS, dispatcher: opts.dispatcher, timeoutMs: opts.timeoutMs });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.body);
    if (j.error) return null;
    const wt = j.parse && j.parse.wikitext;
    if (!wt) return null;
    return { how: "mediawiki-api", status: 200, body: wt, contentType: "text/x-wiki", ok: true, api: api };
  } catch (e) { return null; }
}

/* ---------- 基础 fetch ---------- */

async function rawFetch(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs || 20000);
  try {
    const init = { headers: opts.headers || BROWSER_HEADERS, redirect: "follow", signal: ac.signal };
    if (opts.dispatcher) init.dispatcher = opts.dispatcher;
    const r = await fetch(url, init);
    const body = await r.text();
    clearTimeout(t);
    const blocked = classifyBlock(r.status, body);
    return { how: opts.how || "direct", status: r.status, body, ok: !blocked, blocked, err: blocked || undefined };
  } catch (e) {
    clearTimeout(t);
    return { how: opts.how || "direct", status: 0, body: "", ok: false, blocked: "network", err: String(e && e.message).slice(0, 120) };
  }
}

export async function fetchDirect(url, opts = {}) {
  return rawFetch(url, { ...opts, how: "direct", headers: opts.headers || BROWSER_HEADERS });
}

export async function fetchViaProxy(url, opts = {}) {
  const ag = await proxyAgent();
  if (!ag) return { how: "proxy", status: 0, body: "", ok: false, blocked: "no_proxy", err: "无可用代理（未检测到系统代理，或未安装 undici）" };
  return rawFetch(url, { ...opts, how: "proxy", dispatcher: ag });
}

export async function fetchViaDoh(url, opts = {}) {
  const ag = await dohAgent();
  if (!ag) return { how: "doh", status: 0, body: "", ok: false, blocked: "no_undici", err: "未安装 undici，无法自定义 DNS（在工具目录执行 npm install undici）" };
  return rawFetch(url, { ...opts, how: "doh", dispatcher: ag, headers: opts.headers || BROWSER_HEADERS });
}

/* ---------- 国内 / 境外分流 ---------- */

// 判断"该不该走代理"。国内站点走境外出口常被刁难（NGA 直接 403、百度百科内容缩水），
// 所以国内域名一律建议直连；境外域名才需要代理。
const DOMESTIC_RE = /(\.cn$|\.com\.cn$|baidu\.com|zhihu\.com|nga\.cn|ngabbs\.com|bilibili\.com|biligame\.com|moegirl\.org|17173\.com|hoyolab\.com|mihoyo\.com|miyoushe\.com|aliyun\.com|qq\.com|weibo\.com)/i;
export function looksDomestic(url) {
  try { return DOMESTIC_RE.test(new URL(url).hostname); } catch (e) { return false; }
}

/* ---------- 真浏览器 ---------- */

export async function findBrowser() {
  for (const p of EDGE_CANDIDATES) { try { await fsp.access(p); return p; } catch (e) {} }
  return null;
}

// --dump-dom 直接把渲染完的 DOM 打到 stdout：既过 TLS 指纹，又能跑 JS，还不用装 Playwright。
// userDataDir 指向日常浏览器 profile 时可以借用真实登录 Cookie（对付知乎/Game8 这类）。
export async function fetchBrowser(url, opts = {}) {
  const bin = opts.browser || (await findBrowser());
  if (!bin) return { how: "browser", status: 0, body: "", ok: false, blocked: "no_browser", err: "未找到 Edge/Chrome" };
  const profile = opts.userDataDir || join(HERE, ".profile-tmp");
  // 无头浏览器默认会继承系统代理。国内站点走了境外出口反而会被拦或降级
  // （实测百度百科：走代理 368KB vs --no-proxy-server 3.8MB），所以按站点选路。
  const args = [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--window-size=1920,1080",
    "--virtual-time-budget=" + (opts.waitMs || 15000),
    "--user-data-dir=" + profile,
    // 这一行是过 Cloudflare 的关键：无头模式默认 UA 里带 "HeadlessChrome"，
    // 实测不指定 UA 时 Fandom 停在 28KB 的挑战页，指定后拿到 1.2MB 正文。
    // 不加 --disable-blink-features 也能过，UA 是决定变量。
    "--user-agent=" + BROWSER_HEADERS["User-Agent"],
    ...(opts.noProxy ? ["--no-proxy-server"] : []),
    "--dump-dom", url,
  ];
  return await new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString("utf8"); });
    p.stderr.on("data", () => {});
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, opts.timeoutMs || 70000);
    p.on("close", () => {
      clearTimeout(killer);
      const blocked = out.length === 0 ? "empty" : classifyBlock(200, out);
      resolve({ how: "browser", status: out.length > 0 ? 200 : 0, body: out, ok: !blocked, blocked: blocked || undefined });
    });
  });
}

/* ---------- 编排：按优先级依次尝试 ---------- */

export async function fetchAny(url, opts = {}) {
  const attempts = [];
  const push = (r) => { attempts.push({ how: r.how, status: r.status, bytes: r.body ? r.body.length : 0, ok: r.ok, blocked: r.blocked }); return r; };
  const stop = (r) => { r.attempts = attempts; return r; };

  // 1) 官方 API 优先 —— wiki 系站点这一步就能解决 Cloudflare
  if (opts.preferApi !== false && isMediaWiki(url)) {
    const a = await fetchViaMediaWikiApi(url, opts);
    if (a) { push(a); return stop(a); }
  }
  // 2) 直连
  const d = push(await fetchDirect(url, opts));
  if (d.ok) return stop(d);

  // 3) DNS 污染的话，先试 DoH 直连真 IP（不需要 VPN）
  if (d.blocked === "network" || d.blocked === "browser_error" || d.status === 0) {
    const h = push(await fetchViaDoh(url, opts));
    if (h.ok) return stop(h);
  }
  // 4) 走代理（若系统里配了）
  const p = push(await fetchViaProxy(url, opts));
  if (p.ok) return stop(p);

  // 5) 真浏览器：过服务端 403 风控有效，过 Cloudflare 挑战无效。
  //    国内站点先绕开系统代理再试（境外出口会被国内站刁难）。
  const bOpts = looksDomestic(url) ? { ...opts, noProxy: true } : opts;
  const b = push(await fetchBrowser(url, bOpts));
  if (b.ok) return stop(b);

  const last = attempts[attempts.length - 1];
  return stop({
    how: "none", status: 0, body: "", ok: false, attempts,
    hint: buildHint(attempts),
  });
}

function buildHint(attempts) {
  const kinds = new Set(attempts.map((a) => a.blocked).filter(Boolean));
  const tips = [];
  if (kinds.has("cloudflare")) {
    tips.push("Cloudflare 人机挑战：无头浏览器也过不了。优先改用该站官方 API（MediaWiki 站点的 /api.php 通常不校验），或给无头浏览器传 userDataDir 指向你日常浏览器的 profile 借真实 Cookie。");
  }
  if (kinds.has("network") || kinds.has("browser_error")) {
    tips.push("网络层不通（多为 DNS 污染）：可开代理，或让脚本用 DoH 解析真 IP 直连；若目标 IP 本身被封锁则只能代理。");
  }
  if (kinds.has("waf")) tips.push("服务端风控：先试移动端/WAP 端点与官方 API，再试真浏览器内核；若是国内站且开着代理，先关代理直连（境外出口会被刁难，NGA 直接 403）。");
  if (kinds.has("too_small")) tips.push("返回内容过小，可能是 JS 渲染的 SPA：用无头浏览器 --dump-dom，或直接找它的 XHR 接口。");
  if (tips.length === 0) tips.push("所有方式均失败，建议换数据源（搜索接口、镜像站、Wayback 存档）。");
  return tips.join("\n");
}

/* ---------- CLI ---------- */
function argVal(n, d) { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; }
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/fetch-any.mjs")) {
  const url = process.argv[2];
  if (!url) { console.log("用法: node fetch-any.mjs <url> [--out f] [--wait ms] [--profile dir] [--proxy] [--doh] [--api]"); process.exit(1); }
  let r;
  const only = argVal("--only", "");
  if (only === "doh") r = await fetchViaDoh(url, {});
  else if (only === "proxy") r = await fetchViaProxy(url, {});
  else if (only === "browser") r = await fetchBrowser(url, { waitMs: Number(argVal("--wait", 15000)), userDataDir: argVal("--profile", "") || undefined, noProxy: process.argv.includes("--no-proxy") || looksDomestic(url) });
  else if (only === "api") r = await fetchViaMediaWikiApi(url, {});
  else r = await fetchAny(url, { waitMs: Number(argVal("--wait", 15000)), userDataDir: argVal("--profile", "") || undefined });
  if (r && r.attempts) console.error("尝试: " + r.attempts.map((x) => x.how + "=" + (x.ok ? "OK" : (x.blocked || x.status)) + "(" + x.bytes + "B)").join(" -> "));
  if (!r || !r.ok) { console.error("未取到内容。\n" + ((r && r.hint) || "")); process.exit(2); }
  const out = argVal("--out", "");
  if (out) { await fsp.writeFile(out, r.body, "utf8"); console.error("OK " + r.how + " -> " + out + " (" + r.body.length + "B)"); }
  else process.stdout.write(r.body);
}
