#!/usr/bin/env python3
"""Génère les icônes de Mes Tâches (PWA + launcher Android), sans dépendance.

Une fiche cartonnée avec sa pince et une coche : l'objet le plus direct pour
dire « liste de choses à faire ». Palette indigo, pour ne pas confondre avec
Ma Piscine (bleu cyan) ni GestHôte (vert). Anticrénelage par
suréchantillonnage 3×, encodeur PNG en Python pur (zlib seulement).
"""
import struct
import zlib

BG_TOP = (27, 36, 68)      # #1b2444
BG_BOT = (12, 17, 32)      # #0c1120
CARD_T = (150, 214, 255)   # #96d6ff
CARD_B = (79, 140, 247)    # #4f8cf7
CLIP = (30, 41, 59)        # #1e293b
INK = (11, 18, 32)         # #0b1220

SS = 3                     # facteur de suréchantillonnage


def lerp(a, b, t):
    t = min(1.0, max(0.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


# Géométrie normalisée 0..1.
CARD_X0, CARD_X1 = 0.165, 0.835
CARD_Y0, CARD_Y1 = 0.135, 0.875
RAD = 0.11


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    for cx, cy in ((x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)):
        dx, dy = x - cx, y - cy
        outside_x = (x < x0 + r and cx == x0 + r) or (x > x1 - r and cx == x1 - r)
        outside_y = (y < y0 + r and cy == y0 + r) or (y > y1 - r and cy == y1 - r)
        if outside_x and outside_y:
            return dx * dx + dy * dy <= r * r
    return True


def in_card(x, y):
    return in_round_rect(x, y, CARD_X0, CARD_Y0, CARD_X1, CARD_Y1, RAD)


def in_clip(x, y):
    """Pince du haut : petit rectangle arrondi débordant sur le bord."""
    return in_round_rect(x, y, 0.375, 0.055, 0.625, 0.185, 0.06)


def seg(x, y, ax, ay, bx, by, w):
    """Distance point-segment, pour tracer un trait d'épaisseur w."""
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L))
    px, py = ax + t * dx, ay + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= (w / 2) ** 2


def in_check(x, y):
    """Coche : deux segments, branche courte puis branche longue."""
    return (seg(x, y, 0.315, 0.475, 0.425, 0.585, 0.085) or
            seg(x, y, 0.425, 0.585, 0.655, 0.345, 0.085))


def in_line(x, y):
    """Ligne de texte sous la coche, pour suggérer une liste."""
    return seg(x, y, 0.315, 0.715, 0.605, 0.715, 0.075)


def shade(x, y):
    """Couleur (r, g, b) du point normalisé."""
    if in_clip(x, y):
        return CLIP
    if in_card(x, y):
        if in_check(x, y):
            return INK
        if in_line(x, y):
            return lerp(INK, CARD_B, 0.45)
        t = (x - CARD_X0) / (CARD_X1 - CARD_X0) * 0.5 + (y - CARD_Y0) / (CARD_Y1 - CARD_Y0) * 0.5
        return lerp(CARD_T, CARD_B, t)
    return lerp(BG_TOP, BG_BOT, y)


def render(size):
    """Rend l'icône en RGB, suréchantillonnée puis moyennée."""
    rows = []
    n = SS * SS
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            for sy in range(SS):
                y = (py + (sy + 0.5) / SS) / size
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    c = shade(x, y)
                    r += c[0]
                    g += c[1]
                    b += c[2]
            row += bytes((r // n, g // n, b // n))
        rows.append(row)
    return rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + bytes(r) for r in rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)
    print(path, size, 'px')


if __name__ == '__main__':
    import os
    os.makedirs('www/img', exist_ok=True)
    for s in (192, 512):
        write_png('www/img/icon-%d.png' % s, s, render(s))
