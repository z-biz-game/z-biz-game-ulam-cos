#!/usr/bin/env python3
"""谎话藏数 ULAM 的美术资产工厂（一条命令重产全部位图，产出可复现）。

    python3 assets/gen/gen_art.py            # 写 assets/icons/ + assets/art/ + favicon.ico
    python3 assets/gen/gen_art.py --check    # 只量 IHDR，不写盘（提交前自检用）

视觉母题（不是装饰，是玩法的缩略图）：
  * 一格 = 一个候选数，底色 = 这一格被反驳了几次，沿 --ulam-heat-0..3 的色阶走
    （青 #3ddad7 → 金 #f0b544 → 橙 #eb7850 → 品红 #d64880），所以图标主体就是那块 2x2 热力度网格；
  * 结案时秘密那格被套一个环（js/view.js drawCell 的 game.secret 分支）⇒ 环是"答案"的记号；
  * 指认是那条对角斜线（drawCell 的 game.accused 分支）⇒ 斜线是"谎被抓住"的记号；
  * 底色 #0d1319→#121c24 的墨蓝渐变 = css/game.css 的 body radial-gradient，斜纹 = 谎账本的虚线槽。

颜色一律取自 css/game.css 的 --ulam-* token（改配色就改这里，两边同源于同一份 CSS）。
生成是纯确定性的：SEED 固定，随机只用于 grain 的周期噪声（按 wrap 采样，所以贴图无缝）。
"""
import os
import random
import struct
import sys
import zlib

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow（与本仓量具 make_icons.py 同一依赖）：python3 -m pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ICONS = os.path.join(ROOT, "assets", "icons")
ART = os.path.join(ROOT, "assets", "art")

SEED = 20261002
M = 1024  # 母图边长，其余尺寸由它 LANCZOS 派生

# ---- palette (mirror of css/game.css :root, read from the stylesheet so they cannot drift) ----
def css_tokens():
    """从 css/game.css 里实测取 token；取不到就用同一组字面量兜底（值必须和 CSS 逐字相同）。"""
    path = os.path.join(ROOT, "css", "game.css")
    src = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    want = {
        "--ulam-bg": "#0d1319", "--ulam-bg-2": "#121c24", "--ulam-lit": "#3ddad7",
        "--ulam-accent": "#f0b544", "--ulam-good": "#7fd88f", "--ulam-bad": "#d64880",
        "--ulam-heat-2": "#eb7850",
    }
    out = {}
    for k, fb in want.items():
        lit = fb.lstrip("#")
        # CSS 里 heat 是 rgba(...)，所以只在能取到十六进制 token 时用 CSS 的值
        i = src.find(k + ":")
        if i >= 0:
            j = src.index(";", i)
            val = src[i + len(k) + 1:j].strip()
            if set(val.lstrip("#").lower()) <= set("0123456789abcdef") and val.startswith("#"):
                out[k] = val
                continue
        out[k] = fb
    return out


TK = css_tokens()


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


BG = rgb(TK["--ulam-bg"])
BG2 = rgb(TK["--ulam-bg-2"])
TEAL = rgb(TK["--ulam-lit"])
GOLD = rgb(TK["--ulam-accent"])
GREEN = rgb(TK["--ulam-good"])
MAGENTA = rgb(TK["--ulam-bad"])
ORANGE = rgb(TK["--ulam-heat-2"])
INK = (231, 236, 242)
HEAT = [TEAL, GOLD, ORANGE, MAGENTA]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(size, top, bottom):
    """Faster gradient via one-column scale + resize (identical output, 1024^2 would crawl)."""
    w, h = size
    ramp = Image.new("RGB", (1, h))
    px = ramp.load()
    for y in range(h):
        px[0, y] = lerp(top, bottom, y / max(1, h - 1))
    return ramp.resize((w, h), Image.BILINEAR)


def draw_grid_motif(canvas, box, ring_cell=3, gap_frac=0.10, corner_frac=0.18,
                    show_ring=True, show_slash=True, hatch=True):
    """The 2x2 heat grid: the board's whole idea in four squares.

    canvas: PIL Image to draw onto; box: (x0, y0, size) of the motif square.
    Cell order matches view.js id 1..4 → TL, TR, BL, BR (cols = ceil(sqrt(n)) = 2).
    """
    x0, y0, size = box
    d = ImageDraw.Draw(canvas, "RGBA")
    if hatch:
        # 谎账本的虚线槽：45° 短划，压在格子**底下**，只作为质感，不抢信息
        step = max(10, size // 12)
        dash = max(4, size // 40)
        for k in range(-2 * size // step, 3):
            base = y0 + k * step
            for s in range(0, size, dash * 2):
                x = x0 + s
                y = base + s
                if y < y0 or y > y0 + size:
                    continue
                d.line([x, y, min(x + dash, x0 + size), y + dash], fill=(231, 236, 242, 14), width=2)
    gap = int(size * gap_frac)
    cell = (size - gap) // 2
    r = max(2, int(cell * corner_frac))
    centres = {}
    for i, colour in enumerate(HEAT):
        c, row = i % 2, i // 2
        cx0 = x0 + c * (cell + gap)
        cy0 = y0 + row * (cell + gap)
        d.rounded_rectangle([cx0, cy0, cx0 + cell, cy0 + cell], radius=r, fill=colour + (255,))
        # inner shading so a flat colour still reads as a plate, not a sticker
        d.rounded_rectangle([cx0 + 1, cy0 + 1, cx0 + cell - 1, cy0 + cell - 1], radius=r - 1,
                            outline=(255, 255, 255, 26), width=1)
        centres[i] = (cx0 + cell // 2, cy0 + cell // 2, cell)
    if show_ring:
        # 结案: the secret gets a ring (view.js draws an arc of r = w*0.44)
        cx, cy, cell = centres[3]
        rr = int(cell * 0.44)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=TEAL + (255,), width=ring_cell)
    if show_slash:
        # 指认: the diagonal of the accused cell
        cx, cy, cell = centres[3]
        p = int(cell * 0.30)
        d.line([cx - p, cy - p, cx + p, cy + p], fill=GOLD + (255,), width=ring_cell)
    return centres


def master_icon():
    img = vgrad((M, M), BG2, BG).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    # faint radial wash, echoing body's radial-gradient(125% 100% at 50% 0%)
    wash = Image.new("L", (M, M), 0)
    wd = ImageDraw.Draw(wash)
    wd.ellipse([int(M * 0.08), -int(M * 0.34), int(M * 0.92), int(M * 1.1)], fill=26)
    img.paste(Image.new("RGBA", (M, M), BG2 + (255,)), (0, 0), wash)
    draw_grid_motif(img, (int(M * 0.20), int(M * 0.20), int(M * 0.60)), ring_cell=max(6, M // 150))
    # 1px-ish frame, the same hairline as --ulam-line
    d.rounded_rectangle([4, 4, M - 5, M - 5], radius=int(M * 0.16), outline=(215, 231, 240, 30), width=4)
    return img


def maskable_icon():
    """Same motif, full-bleed and shrunk into the 80% safe zone (PWA maskable rule)."""
    img = vgrad((M, M), BG2, BG).convert("RGBA")
    draw_grid_motif(img, (int(M * 0.29), int(M * 0.29), int(M * 0.42)), ring_cell=max(5, M // 180))
    return img


def favicon_master():
    """Small-size variant: 2x2 grid only, no hairlines, thicker ring — 16px must still read."""
    s = 256
    img = vgrad((s, s), BG2, BG).convert("RGBA")
    draw_grid_motif(img, (int(s * 0.13), int(s * 0.13), int(s * 0.74)),
                    ring_cell=10, gap_frac=0.13, corner_frac=0.22, hatch=False)
    return img


def og_card():
    W, H = 1200, 630
    img = vgrad((W, H), BG2, BG).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    # left: the motif, right: the headline the repo exists to print
    draw_grid_motif(img, (64, 128, 380), ring_cell=7)
    font_cjk, font_mono = load_fonts()
    tx, ty = 512, 150
    d.text((tx, ty), "谎话藏数", font=font_cjk(84), fill=INK + (255,))
    d.text((tx, ty + 108), "ULAM · 一个数藏在 1..n 里，对方最多撒 k 个谎", font=font_cjk(30),
           fill=(231, 236, 242, 168))
    # the two numbers, side by side — 体积界 vs 极小极大 DP 真值
    by = ty + 186
    d.rounded_rectangle([tx, by, tx + 250, by + 118], radius=14, fill=BG + (255,),
                        outline=(215, 231, 240, 60), width=2)
    d.rounded_rectangle([tx + 272, by, tx + 522, by + 118], radius=14,
                        fill=lerp(BG, MAGENTA, 0.12) + (255,), outline=(214, 72, 128, 200), width=2)
    d.text((tx + 22, by + 16), "体积界", font=font_cjk(22), fill=(231, 236, 242, 140))
    d.text((tx + 22, by + 48), "4", font=font_mono(44), fill=(231, 236, 242, 200))
    d.text((tx + 60, by + 62), "问", font=font_cjk(28), fill=(231, 236, 242, 150))
    d.text((tx + 294, by + 16), "精确值", font=font_cjk(22), fill=GOLD + (230,))
    d.text((tx + 294, by + 48), "5", font=font_mono(44), fill=GOLD + (255,))
    d.text((tx + 332, by + 62), "问", font=font_cjk(28), fill=GOLD + (200,))
    d.text((tx + 22, by + 136), "3 个数 / 1 个谎：教科书说 4 问必中，DP 量出来是 5。",
           font=font_cjk(24), fill=(231, 236, 242, 150))
    d.text((tx + 22, by + 176), "浏览器只读表，不搜索 —— 整局打完 searchNodes 仍是 0。",
           font=font_cjk(24), fill=TEAL + (200,))
    d.text((64, H - 70), "z-biz-game · Rényi–Ulam · 零依赖 ES Modules", font=font_cjk(22),
           fill=(231, 236, 242, 110))
    return img


def load_fonts():
    """CJK + mono discovery; a machine without PingFang must still produce a readable card."""
    cands = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    cjk = next((c for c in cands if os.path.exists(c)), None)
    mono_cands = ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc",
                  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
    mono = next((c for c in mono_cands if os.path.exists(c)), cjk)

    if cjk is None:
        sys.stderr.write("⚠ 未找到 CJK 字体：og 卡上的中文会退化（位图默认字体）\n")
        fallback = lambda _size: ImageFont.load_default()
        return fallback, fallback
    return (lambda size: ImageFont.truetype(cjk, size)), (lambda size: ImageFont.truetype(mono, size))


def board_grain(size=256):
    """Seamless tileable plate texture: periodic value noise + faint diagonal hairlines.

    Periodic by construction — the noise lattice is sampled with wrap-around and the hairline
    period divides `size`, so createPattern(..., 'repeat') has no visible seam at any cell size.
    """
    rnd = random.Random(SEED)
    lat = 32
    grid = [[rnd.random() for _ in range(lat)] for _ in range(lat)]

    def noise(x, y):
        gx, gy = x / size * lat, y / size * lat
        x0, y0 = int(gx) % lat, int(gy) % lat
        x1, y1 = (x0 + 1) % lat, (y0 + 1) % lat
        fx, fy = gx - int(gx), gy - int(gy)
        sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        a = grid[y0][x0] + (grid[y0][x1] - grid[y0][x0]) * sx
        b = grid[y1][x0] + (grid[y1][x1] - grid[y1][x0]) * sx
        return a + (b - a) * sy

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        for x in range(size):
            n = noise(x, y)
            v = int(n * 26)                      # 0..26 of luminance
            px[x, y] = (INK[0], INK[1], INK[2], v if v > 9 else 2)
    d = ImageDraw.Draw(img, "RGBA")
    step = size // 8                             # divides size → wraps seamlessly
    for k in range(-8, 9):
        d.line([k * step, 0, k * step + size, size], fill=(TEAL[0], TEAL[1], TEAL[2], 7), width=1)
    return img


def secret_seal(size=192):
    """Sprite drawn once per lot: the ring + crosshair the board puts on the secret cell."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    pad = int(size * 0.10)
    w = max(3, size // 22)
    d.ellipse([pad, pad, size - pad, size - pad], outline=TEAL + (235,), width=w)
    d.ellipse([pad + w, pad + w, size - pad - w, size - pad - w], outline=(255, 255, 255, 40), width=1)
    inner = int(size * 0.30)
    d.ellipse([size // 2 - inner // 2, size // 2 - inner // 2,
               size // 2 + inner // 2, size // 2 + inner // 2], fill=GOLD + (255,))
    tick = int(size * 0.06)
    for ang in range(0, 360, 90):
        a = ang * 3.141592653589793 / 180
        cx, cy = size / 2 + (size / 2 - pad + tick) * __import__("math").cos(a), \
                 size / 2 + (size / 2 - pad + tick) * __import__("math").sin(a)
        d.ellipse([cx - w, cy - w, cx + w, cy + w], fill=TEAL + (200,))
    return img


def save(img, name, sizes=None):
    path = os.path.join(ICONS, name) if name.startswith("icon") or name.startswith("maskable") \
        or name.startswith("apple-touch") or name.startswith("favicon") else os.path.join(ART, name)
    img.save(path, "PNG", optimize=True)
    return path


def png_ihdr(path):
    with open(path, "rb") as fh:
        head = fh.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} 不是 PNG")
    w, h = struct.unpack(">II", head[16:24])
    depth, ctype = head[24], head[25]
    return w, h, depth, ctype


def main():
    check = "--check" in sys.argv[1:]
    if check:
        rows = []
        for base in (ICONS, ART):
            if not os.path.isdir(base):
                continue
            for f in sorted(os.listdir(base)):
                if f.endswith(".png"):
                    p = os.path.join(base, f)
                    w, h, depth, ctype = png_ihdr(p)
                    rows.append((os.path.relpath(p, ROOT), w, h, os.path.getsize(p)))
        for rel, w, h, sz in rows:
            flag = "OK " if (sz > 0 and w and h) else "BAD"
            print(f"{flag} {rel} {w}x{h} {sz}B")
        print(f"--check: {len(rows)} PNG")
        return

    os.makedirs(ICONS, exist_ok=True)
    os.makedirs(ART, exist_ok=True)
    master = master_icon()
    fav_master = favicon_master()
    written = []

    for s in (1024, 512, 192, 96, 64, 48, 32, 16):
        written.append(save(master.resize((s, s), Image.LANCZOS), f"icon-{s}.png"))
    written.append(save(master.resize((180, 180), Image.LANCZOS), "apple-touch-icon.png"))
    written.append(save(maskable_icon().resize((512, 512), Image.LANCZOS), "maskable-512.png"))
    for s in (32, 48, 180):
        written.append(save(fav_master.resize((s, s), Image.LANCZOS), f"favicon-{s}.png"))

    # favicon.ico at the document root: the one request a page cannot name in a <link> on every
    # browser, so it ships as a real multi-size ICO instead of a 404 the console counts.
    ico = os.path.join(ROOT, "favicon.ico")
    fav_master.resize((48, 48), Image.LANCZOS).save(
        ico, "ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    written.append(save(board_grain(), "board-grain.png"))
    written.append(save(secret_seal(), "secret-seal.png"))
    written.append(save(og_card(), "og-card.png"))

    for p in sorted(written) + [ico]:
        w, h, _, _ = png_ihdr(p) if p.endswith(".png") else (0, 0, 0, 0)
        print(f"{'OK ' if os.path.getsize(p) > 0 else 'BAD'} {os.path.relpath(p, ROOT)} "
              f"{w}x{h} {os.path.getsize(p)}B")
    print(f"wrote {len(written) + 1} files (seed {SEED})")


if __name__ == "__main__":
    main()
