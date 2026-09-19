# asr.py — 用 SenseVoice 批量转写已下载的音频。模型只加载一次，62 个视频一个进程跑完。
import os, sys, json, time, subprocess
from pathlib import Path

ENGINE = r"C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-video-understand\engine"
sys.path.insert(0, ENGINE)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("ASR_CPU_THREADS", "8")

HERE = Path(__file__).resolve().parent
AUDIO = HERE / "audio"
TRANS = HERE / "transcripts"
TRANS.mkdir(exist_ok=True)

from asr_sensevoice import SenseVoiceASR  # noqa: E402

def to_wav(src: Path, dst: Path) -> bool:
    if dst.exists() and dst.stat().st_size > 1000:
        return True
    r = subprocess.run(["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                        "-f", "wav", str(dst)], capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        print("  ffmpeg 失败: " + (r.stderr or "")[-300:], flush=True)
        return False
    return True

def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srcs = sorted([p for p in AUDIO.iterdir() if p.suffix.lower() in (".m4a", ".mp3", ".wav", ".aac", ".flac") and ".16k." not in p.name])
    todo = [p for p in srcs if not (TRANS / (p.stem + ".txt")).exists()]
    if limit > 0:
        todo = todo[:limit]
    print("音频 " + str(len(srcs)) + " 个，待转写 " + str(len(todo)) + " 个", flush=True)
    if not todo:
        return
    asr = SenseVoiceASR(device="cpu")
    total_audio = 0.0
    t_all = time.time()
    for i, src in enumerate(todo, 1):
        bvid = src.stem
        wav = AUDIO / (bvid + ".16k.wav")
        t0 = time.time()
        if not to_wav(src, wav):
            continue
        try:
            segs = asr.transcribe(str(wav), str(TRANS / (bvid + ".jsonl")), model="small", lang="zh")
        except Exception as e:
            print("  [" + bvid + "] 转写失败: " + str(e)[:300], flush=True)
            continue
        text = "\n".join((s.get("text") or "").strip() for s in segs if (s.get("text") or "").strip())
        (TRANS / (bvid + ".txt")).write_text(text, encoding="utf-8")
        dur = segs[-1].get("end", 0) if segs else 0
        el = time.time() - t0
        total_audio += dur
        spd = (dur / el) if el > 0 and dur > 0 else 0
        print("[" + str(i) + "/" + str(len(todo)) + "] " + bvid + " 音频 " + str(round(dur / 60, 1)) + "min 用时 "
              + str(round(el, 1)) + "s " + str(round(spd, 1)) + "x 字数 " + str(len(text)), flush=True)
    el = time.time() - t_all
    print("=== 全部完成: " + str(len(todo)) + " 个, 音频合计 " + str(round(total_audio / 60, 1)) + "min, 墙钟 "
          + str(round(el / 60, 1)) + "min, 平均 " + str(round(total_audio / el, 1)) + "x 实时 ===", flush=True)

main()
