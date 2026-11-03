# Quick Look draws build/icon.svg on a white background: cut the rounded square back out so the
# icon's corners are transparent. Used by `npm run icon` (needs Pillow: pip3 install pillow).
import sys
from PIL import Image, ImageDraw

path = sys.argv[1]
icon = Image.open(path).convert('RGBA')
scale = 4  # draw the mask bigger, then shrink it, for smooth edges
mask = Image.new('L', (1024 * scale, 1024 * scale), 0)
# The square in icon.svg, one pixel in so no white edge is left
ImageDraw.Draw(mask).rounded_rectangle([101 * scale, 101 * scale, 923 * scale, 923 * scale], radius=184 * scale, fill=255)
icon.putalpha(mask.resize(icon.size, Image.LANCZOS))
icon.save(path)
