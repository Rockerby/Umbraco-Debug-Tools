#!/usr/bin/env python3
"""
Generate PNG icons for the Umbraco Debug Tools Chrome extension.
Draws a simple "U" letter on a dark navy background with a teal debug dot.
Uses only Python standard library (struct + zlib).
"""

import struct
import zlib
import os
import math

def pack_chunk(name, data):
    c = struct.pack('>I', len(data)) + name + data
    crc = zlib.crc32(name + data) & 0xFFFFFFFF
    c += struct.pack('>I', crc)
    return c

def create_png(pixels, width, height):
    """
    pixels: list of rows, each row a list of (R, G, B, A) tuples.
    """
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>II', width, height) + bytes([8, 6, 0, 0, 0])  # 8-bit RGBA
    raw = b''
    for row in pixels:
        raw += b'\x00'  # filter type: None
        for r, g, b, a in row:
            raw += bytes([r, g, b, a])
    compressed = zlib.compress(raw, 9)
    png = sig
    png += pack_chunk(b'IHDR', ihdr)
    png += pack_chunk(b'IDAT', compressed)
    png += pack_chunk(b'IEND', b'')
    return png

def lerp(a, b, t):
    return a + (b - a) * t

def blend(fg, bg, alpha):
    """Alpha-blend fg over bg, returns (R, G, B, 255)."""
    r = int(fg[0] * alpha + bg[0] * (1 - alpha))
    g = int(fg[1] * alpha + bg[1] * (1 - alpha))
    b = int(fg[2] * alpha + bg[2] * (1 - alpha))
    return (r, g, b, 255)

def draw_icon(size):
    """Draw an icon of the given size. Returns a 2D list of RGBA tuples."""
    # Colours
    BG      = (26,  46,  74,  255)   # #1A2E4A navy
    U_COL   = (255, 255, 255, 255)   # white
    DOT_COL = (78,  201, 176, 255)   # #4EC9B0 teal

    pixels = [[(0, 0, 0, 0)] * size for _ in range(size)]

    # -- Background rounded rectangle --
    r_bg = max(2, size // 6)
    for y in range(size):
        for x in range(size):
            if in_rounded_rect(x, y, 0, 0, size, size, r_bg):
                pixels[y][x] = BG

    # -- "U" shape --
    # Proportions: margin from edge, bar thickness, bottom height
    m      = max(2, size // 5)       # outer margin
    bar_t  = max(1, size // 7)       # thickness of each vertical bar
    bot_h  = max(1, size // 7)       # height of the bottom crossbar
    top_y  = m
    bot_y  = size - m                # bottom of the U (exclusive)
    left_x = m
    right_x= size - m                # right edge of U (exclusive)

    for y in range(top_y, bot_y):
        for x in range(left_x, left_x + bar_t):
            pixels[y][x] = U_COL
        for x in range(right_x - bar_t, right_x):
            pixels[y][x] = U_COL

    for y in range(bot_y - bot_h, bot_y):
        for x in range(left_x, right_x):
            pixels[y][x] = U_COL

    # -- Teal debug dot (bottom-right corner) --
    dot_r  = max(1, size // 7)
    dot_cx = size - m // 2 - dot_r
    dot_cy = size - m // 2 - dot_r

    # White halo behind the dot so it's visible on the background
    halo_r = dot_r + max(1, size // 14)
    draw_circle(pixels, dot_cx, dot_cy, halo_r, BG, size)
    draw_circle(pixels, dot_cx, dot_cy, dot_r, DOT_COL, size)

    # -- Small cross inside the dot (debug "+" symbol) --
    if dot_r >= 3:
        cross_col = (26, 46, 74, 255)
        for dx in range(-dot_r + 2, dot_r - 1):
            px, py = dot_cx + dx, dot_cy
            if 0 <= px < size and 0 <= py < size:
                pixels[py][px] = cross_col
        for dy in range(-dot_r + 2, dot_r - 1):
            px, py = dot_cx, dot_cy + dy
            if 0 <= px < size and 0 <= py < size:
                pixels[py][px] = cross_col

    return pixels

def in_rounded_rect(x, y, rx, ry, rw, rh, radius):
    x0, y0 = rx + radius, ry + radius
    x1, y1 = rx + rw - radius, ry + rh - radius
    if x0 <= x <= x1 and ry <= y < ry + rh: return True
    if ry <= y <= rh - 1 and rx <= x < rx + rw:
        if y0 <= y <= y1: return True
    # Corners
    corners = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
    for cx, cy in corners:
        if math.hypot(x - cx, y - cy) <= radius:
            return True
    return False

def draw_circle(pixels, cx, cy, r, colour, size):
    for y in range(max(0, cy - r - 1), min(size, cy + r + 2)):
        for x in range(max(0, cx - r - 1), min(size, cx + r + 2)):
            if math.hypot(x - cx, y - cy) <= r:
                pixels[y][x] = colour

def main():
    out_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 32, 48, 128):
        pixels = draw_icon(size)
        png_data = create_png(pixels, size, size)
        path = os.path.join(out_dir, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(png_data)
        print(f'  Written {path} ({len(png_data)} bytes)')

if __name__ == '__main__':
    main()
