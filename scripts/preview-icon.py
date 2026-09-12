# -*- coding: utf-8 -*-
"""把生成的 icon.png 分别贴到深色/浅色/强调蓝底上，输出 preview.png 供目检。"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(ROOT, "build", "icon.png")
OUT = os.path.join(ROOT, "build", "icon-preview.png")

icon = Image.open(ICON).convert("RGBA")

# alpha 通道统计，确认透明是否真的生效
a = icon.getchannel("A")
hist = a.histogram()
total = icon.width * icon.height
zero = hist[0]
full = hist[255]
partial = total - zero - full

S = 512
canvas = Image.new("RGBA", (S * 3, S), (0, 0, 0, 255))
bg_colors = [(30, 30, 30), (240, 240, 240), (59, 130, 246)]
for i, c in enumerate(bg_colors):
    panel = Image.new("RGBA", (S, S), c + (255,))
    im = icon.resize((int(S * 0.92), int(S * 0.92)), Image.LANCZOS)
    panel.alpha_composite(im, (int(S * 0.04), int(S * 0.04)))
    canvas.alpha_composite(panel, (i * S, 0))

d = ImageDraw.Draw(canvas)
d.text((10, 10), f"alpha: zero={zero*100//total}% partial={partial*100//total}% full={full*100//total}%", fill=(255, 0, 0, 255))
canvas.convert("RGB").save(OUT, "PNG")
print("saved", OUT)
