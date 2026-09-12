# -*- coding: utf-8 -*-
"""修复结构损坏的 PNG：

某些 PNG 中间夹了非 ASCII 的垃圾 chunk（或 CRC 损坏），PIL 严格解析会报
"broken PNG file"。本脚本按 PNG chunk 结构扫描：
  - 合法 chunk（4 字节长度 + 4 字节 ASCII 类型）保留；
  - 遇到非法类型时向前搜索下一个合法 chunk 头，丢弃中间垃圾字节；
  - 重组时统一重算每个 chunk 的 CRC32；
  - 保证 IEND 收尾。
用法：python repair-png.py <src> <dst>
结果写入同目录 repair-result.txt（UTF-8）。
"""
import os
import struct
import sys
import zlib

SIG = b"\x89PNG\r\n\x1a\n"
ASCII = set(range(65, 91)) | set(range(97, 123))
KNOWN = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"sRGB",
         b"iCCP", b"bKGD", b"pHYs", b"tEXt", b"iTXt", b"zTXt", b"eXIf",
         b"acTL", b"fcTL", b"fdAT", b"cHRM", b"hIST", b"sBIT", b"tIME"}


def is_type(t):
    return len(t) == 4 and all(c in ASCII for c in t)


def repair(data):
    if not data.startswith(SIG):
        raise ValueError("not a PNG")
    p = 8
    chunks = []
    dropped = 0
    n = len(data)
    while p < n:
        if p + 8 > n:
            dropped += n - p
            break
        (length,) = struct.unpack(">I", data[p:p + 4])
        ctype = data[p + 4:p + 8]
        end = p + 12 + length
        if is_type(ctype) and end <= n:
            body = data[p + 8:p + 8 + length]
            chunks.append((ctype, body))
            p = end
            if ctype == b"IEND":
                break
            continue
        # 非法类型：优先「按长度整体跳过」（私有 chunk 类型名非法但长度可信），
        # 判据是跳完后正好落在下一个合法 chunk 头上；否则会切断 IDAT 数据流
        if end + 8 <= n and plausible_header(data, end, n):
            dropped += end - p
            p = end
            continue
        # 长度也不可信：向前找下一个合法头（类型已知 + 长度合理）
        q = p + 1
        found = -1
        while q + 8 <= n:
            t = data[q + 4:q + 8]
            if t in KNOWN and plausible_header(data, q, n):
                found = q
                break
            q += 1
        if found < 0:
            dropped += n - p
            break
        dropped += found - p
        p = found
    if not chunks or chunks[0][0] != b"IHDR":
        raise ValueError("IHDR missing")
    if chunks[-1][0] != b"IEND":
        chunks.append((b"IEND", b""))
    out = bytearray(SIG)
    for ctype, body in chunks:
        out += struct.pack(">I", len(body))
        out += ctype
        out += body
        out += struct.pack(">I", zlib.crc32(ctype + body) & 0xFFFFFFFF)
    return bytes(out), dropped


def main():
    src, dst = sys.argv[1], sys.argv[2]
    result_file = os.path.join(os.path.dirname(os.path.abspath(dst)), "repair-result.txt")
    lines = []
    try:
        with open(src, "rb") as f:
            data = f.read()
        fixed, dropped = repair(data)
        with open(dst, "wb") as f:
            f.write(fixed)
        # 用 PIL 验证可解码
        from PIL import Image
        import io
        im = Image.open(io.BytesIO(fixed))
        im.load()
        lines.append(f"src_bytes={len(data)} fixed_bytes={len(fixed)} dropped={dropped}")
        lines.append(f"decoded={im.size[0]}x{im.size[1]} mode={im.mode}")
        lines.append("STATUS=OK")
    except Exception as e:  # noqa: BLE001
        lines.append(f"STATUS=ERROR {type(e).__name__}: {e}")
    with open(result_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return 0 if lines[-1] == "STATUS=OK" else 1


if __name__ == "__main__":
    sys.exit(main())
