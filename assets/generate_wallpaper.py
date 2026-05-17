#!/usr/bin/env python3
"""生成 8K macOS 多窗口管理桌面壁纸 7680×4320"""
from PIL import Image, ImageDraw
import math

W, H = 7680, 4320
ORANGE = (193, 95, 60)
DARK_ORANGE = (212, 135, 106)
CREAM_TOP = (248, 246, 242)
CREAM_BOTTOM = (240, 237, 230)


def gradient_vertical(img, top_color, bot_color):
    px = img.load()
    for y in range(img.height):
        t = y / img.height
        r = int(top_color[0] * (1 - t) + bot_color[0] * t)
        g = int(top_color[1] * (1 - t) + bot_color[1] * t)
        b = int(top_color[2] * (1 - t) + bot_color[2] * t)
        for x in range(img.width):
            px[x, y] = (r, g, b)


def apply_brightness_gradient(img, top_boost=0.03, bot_dim=0.02):
    px = img.load()
    h = img.height
    for y in range(h):
        if y < h / 3:
            factor = 1 + top_boost * (1 - y / (h / 3))
        elif y > 2 * h / 3:
            factor = 1 - bot_dim * ((y - 2 * h / 3) / (h / 3))
        else:
            factor = 1.0
        for x in range(img.width):
            r, g, b = px[x, y][:3]
            px[x, y] = (
                min(255, int(r * factor)),
                min(255, int(g * factor)),
                min(255, int(b * factor)),
            )


def darken_zone(img, x1, y1, x2, y2, darken=0.05):
    px = img.load()
    for y in range(int(y1), int(y2)):
        for x in range(int(x1), int(x2)):
            r, g, b = px[x, y][:3]
            px[x, y] = (
                int(r * (1 - darken)),
                int(g * (1 - darken)),
                int(b * (1 - darken)),
            )


def draw_slash_texture(img, alpha_pct=0.05):
    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    a = int(255 * alpha_pct)
    spacing = 80
    for offset in range(-img.height, img.width + img.height, spacing):
        d.line(
            [(offset, 0), (offset + img.height, img.height)],
            fill=(193, 95, 60, a),
            width=1,
        )
    img.paste(overlay, (0, 0), overlay)


def draw_zone_dashes_v(img, x, y1, y2, color, alpha_pct, dash=24, gap=16, width=2):
    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    a = int(255 * alpha_pct)
    y = y1
    while y < y2:
        d.line([(x, y), (x, min(y + dash, y2))], fill=(*color, a), width=width)
        y += dash + gap
    img.paste(overlay, (0, 0), overlay)


def draw_zone_dashes_h(img, x1, x2, y, color, alpha_pct, dash=24, gap=16, width=2):
    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    a = int(255 * alpha_pct)
    x = x1
    while x < x2:
        d.line([(x, y), (min(x + dash, x2), y)], fill=(*color, a), width=width)
        x += dash + gap
    img.paste(overlay, (0, 0), overlay)


def draw_starburst(img, cx, cy, r, color, alpha_pct=0.15):
    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    a = int(255 * alpha_pct)
    n_points = 8
    for i in range(n_points):
        angle = i * (2 * math.pi / n_points)
        x = cx + r * math.cos(angle)
        y = cy + r * math.sin(angle)
        inner_r = r * 0.35
        inner_angle = angle + math.pi / n_points
        ix = cx + inner_r * math.cos(inner_angle)
        iy = cy + inner_r * math.sin(inner_angle)
        next_angle = (i + 1) * (2 * math.pi / n_points)
        nx = cx + r * math.cos(next_angle)
        ny = cy + r * math.sin(next_angle)
        d.polygon([(cx, cy), (x, y), (ix, iy)], fill=(*color, a))
        d.polygon([(cx, cy), (ix, iy), (nx, ny)], fill=(*color, a))
    d.ellipse(
        [cx - r * 0.18, cy - r * 0.18, cx + r * 0.18, cy + r * 0.18],
        fill=(*color, min(255, int(a * 1.2))),
    )
    img.paste(overlay, (0, 0), overlay)


def build(dark=False, out_path=None):
    if dark:
        bg_top = (35, 35, 35)
        bg_bot = (25, 25, 25)
        accent = DARK_ORANGE
        zone_dim = 0.08
    else:
        bg_top = CREAM_TOP
        bg_bot = CREAM_BOTTOM
        accent = ORANGE
        zone_dim = 0.05

    img = Image.new('RGB', (W, H), bg_top)
    gradient_vertical(img, bg_top, bg_bot)
    apply_brightness_gradient(
        img,
        top_boost=0.03 if not dark else -0.02,
        bot_dim=0.02 if not dark else -0.01,
    )

    LEFT_W = int(W * 0.12)
    MID_W = int(W * 0.60)
    RIGHT_X = LEFT_W + MID_W

    darken_zone(img, 0, 0, LEFT_W, H, darken=zone_dim)

    draw_slash_texture(img, alpha_pct=0.05 if not dark else 0.03)

    draw_zone_dashes_v(img, LEFT_W, 0, H, color=accent, alpha_pct=0.05)
    draw_zone_dashes_v(img, RIGHT_X, 0, H, color=accent, alpha_pct=0.05)
    draw_zone_dashes_h(img, RIGHT_X, W, H // 2, color=accent, alpha_pct=0.05)

    # 左上角星爆图标：菜单栏下方 100px + 左 100px，120×120
    icon_cx = 100 + 60
    icon_cy = 30 + 100 + 60  # 30 菜单栏 + 100 偏移 + 60 半径
    draw_starburst(img, icon_cx, icon_cy, r=60, color=accent, alpha_pct=0.15)

    if out_path is None:
        out_path = '/tmp/wallpaper_{}.png'.format('dark' if dark else 'light')
    # 224 PPI（视网膜像素级校准）+ optimize + 抗锯齿（Pillow LANCZOS is implicit for resize, here直接生成不缩放）
    img.save(out_path, 'PNG', optimize=True, dpi=(224, 224))
    return out_path


if __name__ == '__main__':
    import sys
    light = build(
        dark=False,
        out_path='/Users/hxx/Desktop/claude-panel/assets/wallpaper-light-8k.png',
    )
    dark = build(
        dark=True,
        out_path='/Users/hxx/Desktop/claude-panel/assets/wallpaper-dark-8k.png',
    )
    print(f'Light: {light}')
    print(f'Dark: {dark}')
