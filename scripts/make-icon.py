# Generates build/icon.png and build/icon.ico (run: python3 scripts/make-icon.py)
from PIL import Image, ImageDraw

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# Gradient rounded square
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
a, b = (79, 99, 245), (124, 92, 246)
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=230, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
# Chat bubble
d.rounded_rectangle([230, 250, 794, 650], radius=120, fill=(255, 255, 255, 255))
d.polygon([(330, 600), (300, 800), (480, 640)], fill=(255, 255, 255, 255))
# Three dots
for cx in (382, 512, 642):
    d.ellipse([cx - 42, 450 - 42, cx + 42, 450 + 42], fill=(95, 96, 245, 255))

big = img.resize((512, 512), Image.LANCZOS)
big.save('build/icon.png')
img.resize((256, 256), Image.LANCZOS).save(
    'build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('ok')
