#!/usr/bin/env python3
"""Generate the PWA icons (stdlib only): python3 app/dev/make_icons.py

Writes app/icons/icon-192.png, icon-512.png and icon-maskable-512.png.
The glyph is a small graph: one centre node linked to five neighbours.
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"

BG = (18, 22, 42)          # keep in sync with manifest background_color (#12162a)
LINK = (120, 132, 176)
CENTRE = (255, 196, 61)
# (angle in degrees, distance from centre, radius, colour) in glyph units, glyph spans about [-1, 1]
NEIGHBOURS = [
    (-90, 0.80, 0.150, (94, 200, 255)),
    (-18, 0.84, 0.125, (255, 122, 144)),
    (52, 0.78, 0.150, (126, 226, 156)),
    (128, 0.82, 0.125, (190, 150, 255)),
    (198, 0.80, 0.140, (255, 160, 90)),
]
CENTRE_R = 0.27
LINK_W = 0.035
# extra links between neighbours (indexes), to hint at clusters
SIDE_LINKS = [(0, 1), (2, 3)]


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def render(size, glyph_scale):
    """glyph_scale: half-extent of the glyph as a fraction of the icon size."""
    c = size / 2
    u = size * glyph_scale
    nodes = [
        (c + math.cos(math.radians(a)) * d * u, c + math.sin(math.radians(a)) * d * u, r * u, col)
        for a, d, r, col in NEIGHBOURS
    ]
    links = [(c, c, n[0], n[1]) for n in nodes]
    links += [(nodes[i][0], nodes[i][1], nodes[j][0], nodes[j][1]) for i, j in SIDE_LINKS]
    circles = nodes + [(c, c, CENTRE_R * u, CENTRE)]
    half_w = LINK_W * u

    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter type: none
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            col = BG
            d = min(seg_dist(px, py, *l) for l in links) - half_w
            if d < 0.5:
                col = mix(col, LINK, min(1.0, 0.5 - d))
            for cx, cy, r, ccol in circles:
                d = math.hypot(px - cx, py - cy) - r
                if d < 0.5:
                    col = mix(col, ccol, min(1.0, 0.5 - d))
            rows += bytes(col)
    return bytes(rows)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path, size, raw):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)
    print(f"{path.name}: {size}x{size}, {len(png)} bytes")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # Regular icons: glyph fills most of the square.
    write_png(OUT / "icon-192.png", 192, render(192, 0.40))
    write_png(OUT / "icon-512.png", 512, render(512, 0.40))
    # Maskable: everything must sit inside the central circle of radius 40% of the size.
    # Farthest glyph point = 0.84 + 0.125 = 0.965 units -> 0.965 * 0.36 = 0.35 < 0.40.
    write_png(OUT / "icon-maskable-512.png", 512, render(512, 0.36))


if __name__ == "__main__":
    main()
