# 构建脚本

这套知识库由两套脚本构建，抓取、清洗、转写**全程零 LLM 调用**，只有"理解与分析"这一步用了子代理。

## genshin-kb/ —— biligame 原神WIKI 全站镜像

| 脚本 | 作用 |
|---|---|
| `crawl.mjs` | MediaWiki API 全站抓取（1027 批 / 51,347 页，断点续传）。**必须带浏览器 UA**，否则被 WAF 拦截；`rvprop=content` 硬上限 50 页/请求 |
| `clean.mjs` | 确定性 wikitext → 纯文本清洗器。**表格处理必须晚于模板渲染**，否则模板参数会被当成表格单元格吃掉，整页洗成空 |
| `import.mjs` | 组装条目并写入 kb.sqlite（entries + FTS5 + entries/<id>.md 镜像 + 回滚清单） |
| `index.mjs` | 生成分类索引与总览条目 |
| `verify.mjs` | 离线复刻知识库插件的检索逻辑做验证 |
| `inventory.mjs` / `analyze.mjs` | 全站清单与规模统计 |

## genshin-video-kb/ —— 视频转写与多来源整理

| 脚本 | 作用 |
|---|---|
| `fetch-audio.mjs` | 并发下载音频（只下音轨，比下视频快一个数量级） |
| `asr.py` | SenseVoice 批量转写，模型只加载一次，实测 **14~16 倍实时** |
| `glossary.py` | ASR 专名同音纠错：拼音比对 + **jieba 词典频率过滤**（防止把"地图/星球/附近"这类常用词误改成冷门专名） |
| `import-video-kb.mjs` / `import-website-kb.mjs` / `import-generic-kb.mjs` | 把分析结果统一录入 kb.sqlite |
| `prompt-template.txt` | 视频分析的产出契约（强制六节结构，**把作者推测与游戏内设定分开**） |
| `website-prompt-template.txt` | 《日月全事》手册整理的产出契约（含署名要求） |
| `kaozheng-prompt-template.txt` | 多来源冲突考证的产出契约（**要求并列保留合理分歧，不许强行二选一**） |
| `export-github.mjs` + `post-export.mjs` | 把知识库导出成本仓库的 Markdown 结构 |

## 环境依赖

- Node.js（用内建 `node:sqlite`、`fetch`，无需 npm 依赖）
- Python 3.10+，`pypinyin`、`jieba`（纯文本处理，系统 Python 即可）
- `yt-dlp` + `ffmpeg`（下载与音频转换）
- 语音识别用 `funasr` 的 SenseVoiceSmall

## 四个关键设计

1. **事实与推测分离**：视频分析的产出契约强制六个分节，作者说"可能/我猜"的内容只能进【存疑】节。
2. **证据分层**：整理《日月全事》时要求区分「游戏内文本明写」「官方设定」「玩家推算」「UP 主推断」。
3. **冲突并列保留**：考证脚本明确要求"多种说法都站得住时全部保留，不要为了给结论而牺牲另一种可能"。
4. **零 token 搬运**：抓取、清洗、转写全部是确定性程序，LLM 只用在真正需要理解的分析环节。
