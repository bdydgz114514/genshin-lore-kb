# glossary.py — 用原神专名表做「同音异字」纠正。
# 原理：ASR 的错误绝大多数是同音字（提瓦特→踢瓦特、璃月→里约），所以按无声调拼音比对，
# 拼音完全相同但字不同的窗口即为候选。再按出现次数过滤，只保留系统性错误，避免误伤。
import os, sys, json, re, sqlite3, collections
from pathlib import Path
from pypinyin import lazy_pinyin
import jieba
jieba.initialize()
FREQ = jieba.dt.FREQ

# 判定「错形」是不是一个真实常用词：是的话就别改（地图/星球/附近 都是 蒂图/行秋/福金 的同音词，
# 但它们本身是正确的常用词，改了反而错）。jieba 词典频率做这个过滤非常干净。
COMMON_FREQ = 50
def is_real_word(w):
    if len(w) <= 1:
        return True
    return FREQ.get(w, 0) > COMMON_FREQ

HERE = Path(__file__).resolve().parent
TRANS = HERE / "transcripts"
KB = Path(os.path.expanduser("~")) / ".dsh" / "knowledge" / "kb.sqlite"

CJK = re.compile(r"^[\u4e00-\u9fff]+$")

# 这些是视频里高频出现、但未必是独立页面标题的原学核心词
CURATED = """提瓦特 蒙德 璃月 稻妻 须弥 枫丹 纳塔 至冬 坎瑞亚 天空岛 渊下宫 暗之外海
愚人众 深渊教团 深渊 天理 七神 尘世七执政 神之眼 命之座 元素 魔神 龙王 仙人 夜叉
往生堂 西风骑士团 教令院 天领奉行 社奉行 勘定奉行 蒸汽鸟报 水仙十字结社 黄金剧团
芭芭拉 罗莎莉亚 胡桃 钟离 温迪 雷电将军 纳西妲 芙宁娜 玛薇卡 至冬女皇 派蒙 旅行者
荧 空 戴因斯雷布 尼伯龙根 伊斯塔露 桑多涅 哥伦比娅 阿蕾奇诺 卡皮塔诺 多托雷
璃月七星 凝光 刻晴 甘雨 魈 白术 七七 香菱 行秋 重云 辛焱 烟绯 胡桃 申鹤 夜兰 闲云 嘉明
优菈 安柏 凯亚 丽莎 琴 芭芭拉 迪卢克 诺艾尔 菲谢尔 班尼特 雷泽 砂糖 莫娜 阿贝多 可莉 罗莎莉亚
神里绫华 神里绫人 宵宫 枫原万叶 珊瑚宫心海 五郎 托马 早柚 九条裟罗 雷电将军 八重神子 荒泷一斗 久岐忍 鹿野院平藏
纳西妲 艾尔海森 赛诺 提纳里 妮露 迪希雅 坎蒂丝 柯莱 多莉 莱依拉 珐露珊 流浪者
芙宁娜 那维莱特 林尼 琳妮特 菲米尼 夏沃蕾 娜维娅 克洛琳德 莱欧斯利 希格雯 阿蕾奇诺 千织
玛拉妮 基尼奇 希诺宁 恰斯卡 玛薇卡 茜特菈莉 欧洛伦 伊安珊 瓦雷莎 爱可菲 丝柯克
伊涅芙 法尔伽 尼可 杜林 洛恩 莉奈娅 桑多涅 或然 琅玕 詹诸 白马仙人 努昂诺塔
青雀 六博 郁金香 玫瑰十字 培根 牛顿 笛卡尔 阿多诺 水仙十字 空之神殿 铃风王国 旁白的注脚
奥奇坎 伊尔明 荆夫港 魔山 拜达港 桃都 昆仑 嫦娥 归终 若陀龙王 灶神 锅巴
""".split()

def load_terms():
    terms = set()
    if KB.exists():
        con = sqlite3.connect(str(KB))
        rows = con.execute("SELECT title FROM entries WHERE source LIKE '原神wiki(biligame)%'").fetchall()
        con.close()
        for (t,) in rows:
            if not t.startswith("原神wiki/"):
                continue
            name = t[len("原神wiki/"):]
            if name.startswith("索引/") or name.startswith("卡牌：") or name.startswith("教程：") or name.startswith("沙盒"):
                continue
            if 2 <= len(name) <= 8 and CJK.match(name):
                terms.add(name)
    for w in CURATED:
        if 2 <= len(w) <= 8 and CJK.match(w):
            terms.add(w)
    return sorted(terms)

def build_index(terms):
    # 无声调拼音 -> 词表；多音字按最常用读音，够用来对齐同音错字
    idx = collections.defaultdict(set)
    for t in terms:
        py = "".join(lazy_pinyin(t))
        idx[py].add(t)
    return idx

def scan(text, idx, counts, maxlen=6):
    chars = [c for c in text if CJK.match(c)]
    if not chars:
        return
    pys = lazy_pinyin("".join(chars))
    n = len(chars)
    for i in range(n):
        for L in range(2, maxlen + 1):
            if i + L > n:
                break
            key = "".join(pys[i:i + L])
            cands = idx.get(key)
            if not cands:
                continue
            raw = "".join(chars[i:i + L])
            for t in cands:
                if t != raw and not is_real_word(raw):
                    counts[(raw, t)] += 1

def main():
    terms = load_terms()
    idx = build_index(terms)
    print("专名表 " + str(len(terms)) + " 条，拼音键 " + str(len(idx)) + " 个", flush=True)
    files = sorted(TRANS.glob("*.txt"))
    counts = collections.Counter()
    for i, f in enumerate(files, 1):
        scan(f.read_text(encoding="utf-8"), idx, counts)
        if i % 20 == 0:
            print("  已扫描 " + str(i) + "/" + str(len(files)), flush=True)
    out = [{"wrong": w, "right": r, "count": c} for (w, r), c in counts.most_common() if c >= 3]
    (HERE / "corrections.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("候选更正 " + str(len(out)) + " 条（出现>=3 次且错形不是常用词），已写 corrections.json", flush=True)
    for e in out[:45]:
        print("  " + e["wrong"] + " -> " + e["right"] + "  x" + str(e["count"]))

main()
