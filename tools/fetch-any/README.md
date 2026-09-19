# fetch-any —— 分级降级网页抓取器

抓资料时约四成站点取不到内容，**但它们不是同一个问题**。混在一起处理会白费力气：
有的加多少请求头都没用，换个内核立刻通；有的一开代理反而被拦。

## 用法

```sh
node fetch-any.mjs <url> [--out f] [--wait ms] [--profile dir]
node fetch-any.mjs <url> --only api|doh|proxy|browser   # 只跑某一级
```

stderr 的「尝试」行会告诉你这次是怎么拿到的，例如：
```
尝试: direct=waf(2471B) -> proxy=network(0B) -> browser=OK(3849117B)
```

## 七类拦截与对策（全部实测）

| # | 拦截类型 | 怎么认出来 | 有效对策 | 本机实测 |
|---|---|---|---|---|
| 1 | **DNS 污染** | `Resolve-DnsName` 解析到 `199.59.148.x`（Twitter 老段）/ `157.240.x`（Facebook 段）等对不上的 IP | 开代理；或 DoH 解析真 IP 直连 | ✅ 维基/Fandom/Google 通 |
| 2 | **Cloudflare 人机挑战** | 页面标题 `Just a moment...` / `请稍候…` | ① **改用官方 API**（MediaWiki 的 `api.php` 不做人机校验）<br>② **无头浏览器显式指定 `--user-agent`** | ✅ Fandom `api.php` 200 返回完整 wikitext<br>✅ 加 UA 后 HTML 从 28 KB 挑战页 → 1.2 MB 正文 |
| 3 | **服务端 403 风控** | 403 且无 Cloudflare 特征 | 真浏览器内核（Edge `--dump-dom`） | ✅ 百度百科 4.1 MB |
| 4 | **境外 IP 被封** | **开了代理反而被拦**，关掉就通 | 关代理走直连 | ⚠️ NGA：无 VPN 时真浏览器 227 KB，开 VPN 后 403 |
| 5 | **国内站被代理拖累** | 能拿到内容但明显缩水 | 无头浏览器加 `--no-proxy-server` | ✅ 百度百科 368 KB → 3.8 MB |
| 6 | **JS 渲染 SPA** | 200 但正文为空 | 无头浏览器 `--dump-dom`，或找它的 XHR 接口 | ✅ |
| 7 | **需登录态** | 403 + 参数校验错误 | `--user-data-dir` 指向日常浏览器 profile 借 Cookie | ⚠️ 知乎：问答域不行，专栏域 `zhuanlan.zhihu.com` 可直连 |

## 优先级（很重要）

1. **先找官方 API，再考虑抓 HTML。** wiki 系站点（Wikipedia / Fandom / 各种 MediaWiki）的
   `api.php` 几乎总是绕过 Cloudflare 和 WAF。本工具对疑似 MediaWiki 的 URL 会**自动先试 API**。
2. 再直连 → DoH → 代理 → 真浏览器。

## 三个必须知道的坑

**1. 无头浏览器失败时会 dump 出 Chrome 自己的报错页，体积 300 KB+。**
只看字节数会把它判成"抓到了"。必须识别：`main-frame-error`、`Copyright 2017 The Chromium Authors`、`net::ERR_`。
（本项目第一版就因此把 Fandom「抓成功」了。）

**2. 无头浏览器会继承系统代理。** 国内站点走境外出口会被刁难甚至封锁，
所以本工具对国内域名自动加 `--no-proxy-server`。

**2b. 过 Cloudflare 的决定性变量是 `--user-agent`，不是各种"去自动化特征"开关。**
无头模式默认 UA 里带 `HeadlessChrome`，一眼被识破。严格对照实验：

| 参数 | 结果 |
|---|---|
| `--headless=new` 默认 | 28,734 B ❌ 停在挑战页 |
| 再加 `--disable-blink-features=AutomationControlled` | 28,734 B ❌ 没用 |
| **只加 `--user-agent=<普通 Chrome UA>`** | **1,225,559 B ✅ 通过** |

在 Fandom 中文（599 KB）、Game8（503 KB）、HoYoLAB（1.69 MB）上复现通过。
**但不是万能**：HoneyHunterWorld 加了 UA 仍停在 28 KB 挑战页，属于更严的人机策略，需真实 Cookie。

**3. Node 内建 fetch 不支持代理**，需要 `undici` 的 `ProxyAgent`；
而 `import("undici")` 失败会**直接崩掉整个进程**，必须用 try 包住。本工具已处理。
代理地址会从系统注册表或 `HTTPS_PROXY` 环境变量自动读取。

## 本机实测汇总（2026-09-19，Clash TUN 模式，代理口 7892）

| 站点 | 走法 | 结果 |
|---|---|---|
| 中文维基百科 | mediawiki-api | ✅ 96 KB wikitext |
| Fandom | mediawiki-api | ✅ 22 KB wikitext（绕过 Cloudflare） |
| Wayback Machine | direct | ✅ 464 KB |
| 百度百科 | browser（免代理） | ✅ 4.1 MB |
| Game8 | direct | ✅ 339 KB |
| HoYoLAB wiki | direct | ✅ 7.2 KB |
| biligame | direct | ✅ 600 KB |
| 萌娘百科 | direct | ✅ 921 KB |
| 17173 | direct | ✅ 35 KB |
| 知乎专栏 | direct | ✅ 54 KB |
| NGA | — | ❌ 需关代理（封境外 IP） |
| 知乎问答 | — | ❌ 需登录 Cookie |

## 第八类：JS 空壳站 —— 别渲染，直接找它的内容 API

有些站点页面源码里什么都没有，正文全靠 XHR 拉。渲染能拿到，但有更省事的路：
**在页面 HTML 里搜接口地址**（`fetch(` / `API_URL` / `.json`），直接请求那个接口。

两个实例：
- genshinlore.cn 的「趣闻」页：源码里 `const FACTS_API_URL = '...interestfacts.json'`，直接请求拿到 413 B 的
  纯数据数组——比渲染 DOM 再解析快得多，也稳得多。
- 米游社观测枢（baike.mihoyo.com）是 JS 空壳，但它的内容 API 可直接调用：
  ```
  https://api-static.mihoyo.com/common/blackboard/ys_obc/v1/content/info?app_sn=ys_obc&content_id=<id>
  ```
  实测拿到完整正文（该文用于核验坎瑞亚命名原型）。

**判定口诀**：如果 `--dump-dom` 出来的正文和直接 fetch 的差不多空，就去找 XHR 接口，别再往渲染上使劲。

## 兜底

- `web_search` 常常能直接给出被墙站点的标题和链接（请求不是从本机发的）。
- **Wayback Machine**：站点改版或删帖后的唯一出路，`web.archive.org/web/2024/<url>`。
- **国内替代源**：萌娘百科、17173、biligame 直连可用。
