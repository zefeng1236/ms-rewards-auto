# -*- coding: utf-8 -*-
"""把用户指定的图标源图 build/icon-source.png 转换为应用图标。

源图是透明底的金色勋章 3D 插画（四角 alpha=0，非白底），忠实保留原图，
不做抠图/换底，也不做 USM 锐化（勋章轮廓是平滑抗锯齿渐变，锐化会在半透明
边缘产生彩色镶边）。小源图用 LANCZOS 高质量重采样放大，边缘靠双三次卷积
自然过渡，虽然偏软但干净。

  1. 放大到 1024 正方形 -> build/icon.png（favicon / 侧边栏 logo）
  2. 多尺寸 build/icon.ico（16/24/32/48/64/128/256，exe/托盘/任务栏）
结果写入 icon-result.txt（UTF-8）。
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "icon-source.png")
OUT_PNG = os.path.join(ROOT, "build", "icon.png")
OUT_ICO = os.path.join(ROOT, "build", "icon.ico")
RESULT = os.path.join(ROOT, "icon-result.txt")

TARGET = 1024
lines = []

try:
    img = Image.open(SRC).convert("RGBA")
    lines.append(f"src={img.width}x{img.height}")

    # LANCZOS 高质量放大；不锐化，避免勋章半透明轮廓出现彩色镶边
    base = img.resize((TARGET, TARGET), Image.LANCZOS)
    base.save(OUT_PNG, "PNG")
    lines.append(f"png={OUT_PNG}")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    base.save(OUT_ICO, format="ICO", sizes=[(s, s) for s in sizes])
    lines.append(f"ico={OUT_ICO} sizes={sizes}")
    lines.append("STATUS=OK")
except Exception as e:  # noqa: BLE001
    lines.append(f"STATUS=ERROR {type(e).__name__}: {e}")

with open(RESULT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
sys.exit(0 if lines[-1] == "STATUS=OK" else 1)
