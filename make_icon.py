"""Generate the MD Reader application icon (assets/icon.ico + icon.png)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "assets"
OUT.mkdir(exist_ok=True)

SIZE = 512
ACCENT = (47, 111, 237)
ACCENT2 = (122, 167, 255)


def rounded_rect(draw, xy, r, fill):
    draw.rounded_rectangle(xy, radius=r, fill=fill)


def make(size, simple=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = int(size * 0.10)
    r = int(size * 0.22)
    # background gradient-ish (vertical blend by two rects)
    card = (m, m, size - m, size - m)
    rounded_rect(d, card, r, ACCENT)

    # top highlight
    hi = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hi)
    rounded_rect(hd, card, r, ACCENT2 + (60,))
    img = Image.alpha_composite(img, hi)

    pad = int(size * 0.24)
    # "M" mark: draw with lines for crispness
    x0, y0 = pad, int(size * 0.30)
    x1, y1 = int(size * 0.52), int(size * 0.70)
    wdt = max(2, int(size * 0.075))
    white = (255, 255, 255, 255)
    d = ImageDraw.Draw(img)
    # M strokes
    d.line([(x0, y1), (x0, y0)], fill=white, width=wdt)
    d.line([(x0, y0), ((x0 + x1) // 2, int(size * 0.53))], fill=white, width=wdt)
    d.line([((x0 + x1) // 2, int(size * 0.53)), (x1, y0)], fill=white, width=wdt)
    d.line([(x1, y0), (x1, y1)], fill=white, width=wdt)

    # down arrow (markdown)
    ax = int(size * 0.70)
    ay0 = int(size * 0.30)
    ay1 = int(size * 0.64)
    d.line([(ax, ay0), (ax, ay1)], fill=white, width=wdt)
    head = int(size * 0.11)
    d.line([(ax - head, ay1 - head), (ax, ay1)], fill=white, width=wdt)
    d.line([(ax + head, ay1 - head), (ax, ay1)], fill=white, width=wdt)

    return img


# High-res master and PNG
master = make(SIZE)
master.save(OUT / "icon.png")
sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [make(s) for s in sizes]
imgs[-1].save(OUT / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes])
print("icon written:", OUT / "icon.ico", OUT / "icon.png")
