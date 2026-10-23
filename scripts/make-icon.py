# Generates build/icon.png and build/icon.ico (run: python3 scripts/make-icon.py)
# Two people, green behind and blue in front, a modern take on the classic
# LAN Messenger icon.
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 2048


def gradient(top, bottom):
    g = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(g)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    return g


def person(cx, head_y, scale):
    """Mask of a person: round head over rounded shoulders.
    Positions are given on a 1024 grid and drawn at double size."""
    cx, head_y, scale = cx * 2, head_y * 2, scale * 2
    r = 118 * scale
    w, top = 250 * scale, head_y + r + 34 * scale
    bottom = top + 330 * scale
    # Round shoulders (a tall rounded box cut off at the bottom) with softly
    # rounded lower corners.
    body = Image.new('L', (S, S), 0)
    ImageDraw.Draw(body).rounded_rectangle([cx - w, top, cx + w, bottom + 300 * scale], radius=int(210 * scale), fill=255)
    base = Image.new('L', (S, S), 0)
    ImageDraw.Draw(base).rounded_rectangle([cx - w, top, cx + w, bottom], radius=int(60 * scale), fill=255)
    m = ImageChops.multiply(body, base)
    ImageDraw.Draw(m).ellipse([cx - r, head_y - r, cx + r, head_y + r], fill=255)
    return m


def grow(mask, px):
    return mask.filter(ImageFilter.MaxFilter(px * 2 + 1))


back = person(390, 300, 0.92)
front = person(610, 410, 1.0)
# Clear a thin gap around the front figure so the two read apart.
back = ImageChops.subtract(back, grow(front, 44))

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
img.paste(gradient((74, 222, 128), (22, 163, 74)), (0, 0), back)
img.paste(gradient((96, 165, 250), (37, 99, 235)), (0, 0), front)

# Soft highlight on each head for depth.
shine = Image.new('L', (S, S), 0)
sd = ImageDraw.Draw(shine)
sd.ellipse([600, 420, 800, 580], fill=70)
sd.ellipse([1040, 630, 1250, 800], fill=70)
shine = shine.filter(ImageFilter.GaussianBlur(36))
img.paste(Image.new('RGBA', (S, S), (255, 255, 255, 255)), (0, 0),
          ImageChops.multiply(shine, ImageChops.add(back, front)))

# Trim to content with a small margin, keep it square.
box = img.getbbox()
side = max(box[2] - box[0], box[3] - box[1]) + 120
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(img.crop(box), ((side - (box[2] - box[0])) // 2, (side - (box[3] - box[1])) // 2))

canvas.resize((512, 512), Image.LANCZOS).save('build/icon.png')
canvas.resize((256, 256), Image.LANCZOS).save(
    'build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('ok')
