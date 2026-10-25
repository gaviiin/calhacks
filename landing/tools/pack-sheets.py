#!/usr/bin/env python3
"""Crops generated livery sheets to the shader frame, masks them with the clay reference,
reports alignment and writes WebP variants.

Usage: python3 tools/pack-sheets.py <key> <side.png> [<top.png>]   (use - to skip a view)
Writes public/liveries/<key>/{side,top}.webp (desktop) and {side,top}@1k.webp (phones).
"""
import json, subprocess, sys
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
frames = json.loads((ROOT / 'livery/ref/frames.json').read_text())
SIZES = {'side': (3072, 1536), 'top': (2048, 1024)}  # desktop width, phone width


def crop_rows(img, view):
    """Rows of the 21:9 canvas that the shader frame covers."""
    c = frames['canvas'][view]
    s = frames['sheet'][view]
    h = img.height
    if view == 'side':
        span = c['y1'] - c['y0']
        top = round((1 - (s['y1'] - c['y0']) / span) * h)
        bottom = round((1 - (s['y0'] - c['y0']) / span) * h)
    else:
        span = c['zBottom'] - c['zTop']
        top = round((s['zTop'] - c['zTop']) / span * h)
        bottom = round((s['zBottom'] - c['zTop']) / span * h)
    return img.crop((0, top, img.width, bottom))


def bright_bbox(img, threshold):
    """Bounding box of the painted bodywork: anything brighter than the black background."""
    return img.convert('L').point(lambda v: 255 if v > threshold else 0).getbbox()


def register(gen, ref, dark_body=False):
    """The model keeps the car's shape but tends to drift it a few percent in the frame.
    Match the painted-bodywork extents (rear wing endplate → nose/front wing, airbox apex)
    with a uniform scale from the car's length, then translate so the apexes coincide."""
    rr, gg, bb, aa = ref.split()
    ref_paint = Image.merge('RGB', (rr, gg, bb)).point(lambda v: v)
    ref_paint.putalpha(aa)
    rb = bright_bbox(Image.alpha_composite(Image.new('RGBA', ref.size, (0, 0, 0, 255)), ref_paint), 100)
    gb = bright_bbox(gen, 12 if dark_body else 22)
    scale = (rb[2] - rb[0]) / max(1, gb[2] - gb[0])
    scaled = gen.resize((round(gen.width * scale), round(gen.height * scale)), Image.LANCZOS)
    dx = rb[0] - round(gb[0] * scale)
    dy = rb[1] - round(gb[1] * scale)
    out = Image.new('RGBA', ref.size, (0, 0, 0, 255))
    out.paste(scaled, (dx, dy))
    return out, scale, dx, dy, rb, gb


def alignment(gen_rgba, ref_alpha, threshold):
    """How much painted area still falls outside the clay silhouette after registration."""
    g = gen_rgba.convert('L').point(lambda v: 255 if v > threshold else 0)
    r = ref_alpha.filter(ImageFilter.MaxFilter(7)).point(lambda v: 255 if v > 40 else 0)
    gp, rp = g.load(), r.load()
    bright = spill = 0
    w, h = g.size
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if gp[x, y] > 0:
                bright += 1
                if rp[x, y] == 0:
                    spill += 1
    return spill / bright if bright else 1.0


def pack(key, view, src):
    ref = Image.open(ROOT / f'livery/ref/{view}.png').convert('RGBA')
    gen = Image.open(src).convert('RGBA')
    if gen.size != ref.size:
        gen = gen.resize(ref.size, Image.LANCZOS)
    ref_alpha = ref.split()[3]
    dark_body = key == 'pitwall'
    gen, scale, dx, dy, rb, gb = register(gen, ref, dark_body)
    spill = alignment(gen, ref_alpha, 12 if dark_body else 22)
    print(f'{key}/{view}: registered scale {scale:.4f}, shift ({dx:+d}, {dy:+d}) px; bodywork box ref {rb} vs gen {gb}')
    # The reference silhouette (slightly dilated) is the authoritative mask.
    reg_dir = ROOT / 'livery/gen/registered'
    reg_dir.mkdir(parents=True, exist_ok=True)
    gen.save(reg_dir / f'{key}-{view}.png')
    mask = ref_alpha.filter(ImageFilter.MaxFilter(5))
    gen.putalpha(mask)
    sheet = crop_rows(gen, view)
    out_dir = ROOT / 'public/liveries' / key
    out_dir.mkdir(parents=True, exist_ok=True)
    for suffix, width in (('', SIZES[view][0]), ('@1k', SIZES[view][1])):
        img = sheet.resize((width, round(sheet.height * width / sheet.width)), Image.LANCZOS)
        png = out_dir / f'{view}{suffix}.png'
        img.save(png)
        webp = out_dir / f'{view}{suffix}.webp'
        subprocess.run(['cwebp', '-quiet', '-q', '90', '-alpha_q', '95', '-m', '6', str(png), '-o', str(webp)], check=True)
        png.unlink()
        print(f'{webp.relative_to(ROOT)}  {img.width}x{img.height}  {webp.stat().st_size // 1024} KB')
    print(f'{key}/{view}: paint outside the reference silhouette after registration = {spill * 100:.2f}% (reference mask applied)')


if __name__ == '__main__':
    key, side = sys.argv[1:3]
    top = sys.argv[3] if len(sys.argv) > 3 else '-'
    if side != '-':
        pack(key, 'side', side)
    if top != '-':
        pack(key, 'top', top)
