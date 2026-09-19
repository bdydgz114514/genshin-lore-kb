// clean.mjs — 确定性 wikitext → 纯文本。零 LLM 调用，纯字符串处理。
// 设计目标：把 BWIKI 的 {{模板|key=value}} 信息框、表格、链接还原成可读、可检索的正文。

/* ---------- 平衡扫描 ---------- */

// 从 s[start]（应为 "{{"）找到配对的 "}}" 之后的索引；找不到返回 -1。
export function findTemplateEnd(s, start) {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    if (s[i] === "{" && s[i + 1] === "{") {
      depth++;
      i += s[i + 2] === "{" ? 3 : 2;
      continue;
    }
    if (s[i] === "}" && s[i + 1] === "}") {
      depth--;
      i += s[i + 2] === "}" ? 3 : 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
}

// 按 sep 切分，但忽略 {{...}} / [[...]] / <...> 内部的 sep
export function splitTopLevel(s, sep) {
  const out = [];
  let depthT = 0;
  let depthL = 0;
  let depthA = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" && s[i + 1] === "{") { depthT++; cur += "{{"; i++; continue; }
    if (c === "}" && s[i + 1] === "}") { if (depthT > 0) depthT--; cur += "}}"; i++; continue; }
    if (c === "[" && s[i + 1] === "[") { depthL++; cur += "[["; i++; continue; }
    if (c === "]" && s[i + 1] === "]") { if (depthL > 0) depthL--; cur += "]]"; i++; continue; }
    if (c === "<") { depthA++; cur += c; continue; }
    if (c === ">") { if (depthA > 0) depthA--; cur += c; continue; }
    if (c === sep && depthT === 0 && depthL === 0 && depthA === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// 顶层第一个 "=" 的位置（忽略嵌套内部）
export function topLevelEq(s) {
  let depthT = 0, depthL = 0, depthA = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" && s[i + 1] === "{") { depthT++; i++; continue; }
    if (c === "}" && s[i + 1] === "}") { if (depthT > 0) depthT--; i++; continue; }
    if (c === "[" && s[i + 1] === "[") { depthL++; i++; continue; }
    if (c === "]" && s[i + 1] === "]") { if (depthL > 0) depthL--; i++; continue; }
    if (c === "<") { depthA++; continue; }
    if (c === ">") { if (depthA > 0) depthA--; continue; }
    if (c === "=" && depthT === 0 && depthL === 0 && depthA === 0) {
      if (s[i + 1] === "=") return -1; // 标题语法，不是赋值
      return i;
    }
  }
  return -1;
}

/* ---------- 模板策略 ---------- */

// 纯装饰/导航模板：整段丢弃
const DROP_EXACT = new Set([
  "面包屑", "角色导航", "武器导航", "导航", "Navbox", "navbox", "nav", "Nav",
  "角色立绘", "施工中", "TOC", "目录", "页顶提示",
  "Copyright", "角色图鉴", "武器图鉴导航", "圣遗物导航", "怪物导航",
  "主线导航", "任务导航", "活动导航", "食物导航", "材料导航", "道具导航",
]);
// 导航/页眉页脚：整段丢弃（无正文价值）
const DROP_RE = /(导航|Navbox|面包屑|侧边栏|页脚|页头|页顶|页底|信息框模板|Infobox)/i;
// 包装类：内部是真正的正文，必须展开而不是丢弃
const WRAP_RE = /(折叠|Collapse|Tabber|选项卡|标签页|美化|样式|居中|容器|滚动|轮播|切换)/i;

// 只保留「最后一个有内容的参数」—— 典型的 {{颜色|蓝|文字}} / {{黑幕|文字}}
const UNWRAP_LAST = new Set([
  "颜色", "黑幕", "剧透", "强调", "b", "B", "strong", "font", "span", "small",
  "big", "center", "居中", "nowrap", "tooltip", "悬浮", "大", "小", "蓝", "红",
  "绿", "橙", "紫", "白", "黑", "灰", "黄", "color", "Color", "red", "blue",
  "green", "orange", "purple", "bold", "italic", "sup", "sub", "u", "s", "del",
  "text", "文字", "背景", "高亮", "标记", "划掉", "删除线", "下划线",
]);

// 保留全部参数
const UNWRAP_JOIN = new Set(["注音", "ruby", "拼音", "释义", "释义2", "中文", "翻译", "简繁", "简繁转换"]);

// 命名参数里纯排版、无信息量的键
const JUNK_KEYS = new Set([
  "style", "class", "colspan", "rowspan", "width", "height", "align", "valign",
  "bgcolor", "color", "font", "size", "border", "cellpadding", "cellspacing",
  "float", "clear", "display", "position", "margin", "padding", "top", "left",
  "right", "bottom", "id", "role", "title-attr", "data", "css", "样式", "宽度",
  "高度", "对齐", "居中", "颜色", "背景色", "边框", "间距", "外边距", "内边距",
]);

function isParamName(s) {
  if (s.length === 0 || s.length > 48) return false;
  if (/[\[\]{}<>\n|]/.test(s)) return false;
  return true;
}

/* ---------- 解析一个模板 ---------- */

export function parseTemplate(body, ctx) {
  const parts = splitTopLevel(body, "|");
  let name = renderInline(parts[0], ctx).trim();
  name = name.replace(/\s+/g, " ");
  const args = parts.slice(1);

  // 解析函数 {{#info:...}}
  if (name.charAt(0) === "#") {
    const fn = name.slice(1).toLowerCase().replace(/:$/, "");
    if (fn === "info") {
      const a = args[args.length - 1];
      return a ? renderInline(a, ctx) : "";
    }
    return "";
  }
  // {{!}} → |   {{=}} → =
  if (name === "!") return "|";
  if (name === "=") return "=";
  if (name === "-" || name === "clear" || name === "Clear") return "\n";

  const base = name.split("/")[0].trim();
  if (DROP_EXACT.has(name) || DROP_EXACT.has(base)) return "";
  if (DROP_RE.test(name) && !UNWRAP_LAST.has(name)) return "";

  const named = [];
  const positional = [];
  for (const a of args) {
    const eq = topLevelEq(a);
    if (eq > 0 && isParamName(a.slice(0, eq).trim())) {
      named.push([a.slice(0, eq).trim(), a.slice(eq + 1)]);
    } else {
      positional.push(a);
    }
  }

  if (WRAP_RE.test(name) || WRAP_RE.test(base)) {
    const pieces = positional.map((p) => renderInline(p, ctx).trim()).filter((v) => v !== "");
    for (const kv of named) {
      const v = renderInline(kv[1], ctx).trim();
      if (v !== "") pieces.push(kv[0] + ": " + v);
    }
    return pieces.join("\n");
  }
  if (UNWRAP_LAST.has(name) || UNWRAP_LAST.has(base)) {
    for (let i = positional.length - 1; i >= 0; i--) {
      const v = renderInline(positional[i], ctx).trim();
      if (v !== "") return v;
    }
    return "";
  }
  if (UNWRAP_JOIN.has(name) || UNWRAP_JOIN.has(base)) {
    return positional.map((p) => renderInline(p, ctx).trim()).filter((v) => v !== "").join(" ");
  }
  // 魔术字
  if (name === "PAGENAME" || name === "SUBPAGENAME") return ctx.title;
  if (name === "FULLPAGENAME") return ctx.title;
  if (name === "NAMESPACE" || name === "ns") return "";

  if (named.length > 0) {
    const out = [];
    for (const kv of named) {
      const k = kv[0];
      if (JUNK_KEYS.has(k.toLowerCase())) continue;
      const v = renderInline(kv[1], ctx).trim();
      if (v === "") continue;
      out.push(k + ": " + v);
    }
    return out.join(named.length > 5 ? "\n" : "；");
  }
  const joined = positional.map((p) => renderInline(p, ctx).trim()).filter((v) => v !== "").join("、");
  return joined;
}

/* ---------- 正文渲染 ---------- */

export function renderInline(s, ctx) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "{" && s[i + 1] === "{") {
      const end = findTemplateEnd(s, i);
      if (end < 0) { i += 2; continue; }
      out += parseTemplate(s.slice(i + 2, end - 2), ctx);
      i = end;
      continue;
    }
    if (s[i] === "[" && s[i + 1] === "[") {
      const end = s.indexOf("]]", i + 2);
      if (end < 0) { i += 2; continue; }
      out += renderLink(s.slice(i + 2, end), ctx);
      i = end + 2;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

function renderLink(inner, ctx) {
  const parts = inner.split("|");
  const target = parts[0].trim();
  if (/^(文件|File|Image|图像|图片)\s*:/i.test(target)) return "";
  if (/^(分类|Category)\s*:/i.test(target)) return "";
  if (parts.length >= 2) {
    const disp = parts[parts.length - 1].trim();
    if (/^\d+\s*px$/i.test(disp)) return "";
    if (/^(thumb|thumbnail|left|right|center|frame|none|border|缩略图)$/i.test(disp)) return "";
    return renderInline(disp, ctx);
  }
  return renderInline(target, ctx);
}

/* ---------- 分类提取 ---------- */

export function extractCategories(wt) {
  const out = [];
  const re = /\[\[\s*(?:分类|Category|CATEGORY)\s*:([^\]|]+)(?:\|[^\]]*)?\]\]/gi;
  let m;
  while ((m = re.exec(wt)) !== null) {
    const c = m[1].trim();
    if (c !== "" && out.indexOf(c) < 0) out.push(c);
  }
  return out;
}

/* ---------- 第一个信息框 ---------- */

export function firstInfobox(wt, ctx) {
  let i = 0;
  let guard = 0;
  while (i < wt.length && guard++ < 400) {
    if (wt[i] === "{" && wt[i + 1] === "{") {
      const end = findTemplateEnd(wt, i);
      if (end < 0) break;
      const body = wt.slice(i + 2, end - 2);
      const parts = splitTopLevel(body, "|");
      const name = renderInline(parts[0], ctx).trim();
      const base = name.split("/")[0].trim();
      if (name.charAt(0) !== "#" && !DROP_RE.test(name) && !DROP_EXACT.has(name) && !DROP_EXACT.has(base)) {
        const pairs = [];
        for (const a of parts.slice(1)) {
          const eq = topLevelEq(a);
          if (eq <= 0) continue;
          const k = a.slice(0, eq).trim();
          if (!isParamName(k) || JUNK_KEYS.has(k.toLowerCase())) continue;
          const v = renderInline(a.slice(eq + 1), ctx).trim().replace(/\s+/g, " ");
          if (v === "") continue;
          pairs.push([k, v]);
        }
        if (pairs.length >= 3) return { name, pairs };
      }
      i = end;
      continue;
    }
    i++;
  }
  return null;
}

/* ---------- 主清洗 ---------- */

export function cleanWikitext(wt, title) {
  const ctx = { title: title };
  let s = wt;

  // 1. 注释、ref、不可见块
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*\/>/gi, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/<(gallery|timeline|imagemap|score|math|syntaxhighlight|source|mapframe|maplink)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<nowiki\b[^>]*>([\s\S]*?)<\/nowiki>/gi, "$1");
  s = s.replace(/<noinclude\b[^>]*>[\s\S]*?<\/noinclude>/gi, "");
  s = s.replace(/__[A-Z]+__/g, "");

  // 2. 模板 + 链接（必须先于表格处理：模板参数用 | 分隔，若先跑表格会把参数全部吃掉）
  s = renderInline(s, ctx);

  // 3. 表格标记 → 文本行
  const lines = s.split("\n");
  const tl = [];
  for (let ln of lines) {
    const t = ln.trim();
    if (/^\{\|/.test(t)) continue;
    if (/^\|\}/.test(t)) continue;
    if (/^\|-/.test(t)) { tl.push(""); continue; }
    if (/^!/.test(t)) { tl.push(t.replace(/^!+/, "").replace(/!!/g, " ｜ ")); continue; }
    if (/^\|/.test(t)) {
      let c = t.replace(/^\|+/, "");
      c = c.replace(/^\s*(?:[A-Za-z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^|\s]+)\s*)+\|/, "");
      tl.push(c.replace(/\|\|/g, " ｜ "));
      continue;
    }
    tl.push(ln);
  }
  s = tl.join("\n");

  // 4. HTML 标签
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|td|th|h[1-6]|table|ul|ol|dl|dd|dt|blockquote|section)\s*>/gi, "\n");
  s = s.replace(/<(p|div|tr|li|td|th|h[1-6]|table|ul|ol|dl|dd|dt|blockquote|section|span|font|b|i|u|s|small|big|center|sup|sub)\b[^>]*>/gi, "");
  s = s.replace(/<[^>]{0,200}>/g, "");

  // 5. 标题与列表
  s = s.replace(/^(={1,6})\s*(.+?)\s*\1\s*$/gm, "\n【$2】\n");
  s = s.replace(/^[*#]+\s*/gm, "· ");
  s = s.replace(/^[:;]+\s*/gm, "");

  // 6. 强调、实体、水平线
  s = s.replace(/'{2,5}/g, "");
  s = s.replace(/&nbsp;/gi, " ");
  s = s.replace(/&amp;/gi, "&");
  s = s.replace(/&lt;/gi, "<");
  s = s.replace(/&gt;/gi, ">");
  s = s.replace(/&quot;/gi, '"');
  s = s.replace(/&middot;/gi, "·");
  s = s.replace(/&times;/gi, "×");
  s = s.replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return ""; } });
  s = s.replace(/^----+\s*$/gm, "");

  // 7. 归一化空白
  s = s.replace(/[ \t\u00a0\u3000]+/g, " ");
  s = s.split("\n").map((x) => x.trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/^[·｜、，,;；\s]+$/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  // 兜底：有内容却洗成空（多半是未知模板形态），退回粗剥离，绝不静默丢页
  if (s === "" && wt.trim() !== "") {
    s = wt
      .replace(/\{\{[^{}]*\}\}/g, " ")
      .replace(/\[\[[^\]]*\|([^\]]*)\]\]/g, "$1")
      .replace(/\[\[([^\]]*)\]\]/g, "$1")
      .replace(/<[^>]{0,200}>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return s;
}

/* ---------- 组装知识库条目 ---------- */

export const ABSTRACT_MAX = 240;

export function buildAbstract(cats, info, body, title) {
  const segs = [];
  if (cats.length > 0) segs.push("分类:" + cats.slice(0, 4).join("/"));
  if (info) {
    for (const kv of info.pairs) {
      segs.push(kv[0] + ":" + kv[1]);
      if (segs.join("｜").length > ABSTRACT_MAX) break;
    }
  }
  let head = segs.join("｜");
  if (head.length > ABSTRACT_MAX) return head.slice(0, ABSTRACT_MAX);
  if (head.length >= 60) return head;
  const rest = body.replace(/\n+/g, " ").trim();
  const room = ABSTRACT_MAX - head.length - 1;
  if (room > 20 && rest !== "") head = head === "" ? rest.slice(0, ABSTRACT_MAX) : head + "｜" + rest.slice(0, room);
  return head.slice(0, ABSTRACT_MAX);
}
