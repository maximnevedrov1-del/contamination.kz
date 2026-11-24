"""help/token.gif — where the Kaspi API token is and where it goes in SaudaPulse.

Made from screenshots of a real Kaspi seller cabinet (not stored in the repository: they show the
seller's name, partner ID, shop, phone and token) plus two screenshots of the extension's
«Подключить магазин» dialog. Every personal value is painted over before cropping.

    python3 token.py <dir with k1..k4.png (Kaspi) and e1, e2.png (extension)> ../../help/token.gif

k1 — orders page, k2 — menu scrolled to «Настройки», k3 — «Информация о магазине»,
k4 — «Токен API» tab; e1 — dashboard (1476×800), e2 — the connect dialog filled in.
Coordinates below are for those screenshots (≈1920×930); re-check them if new ones are taken.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

src, out = sys.argv[1], sys.argv[2]
W, H, CAP = 840, 525, 70          # frame, caption band at the bottom
AREA_H = H - CAP
RED = (225, 29, 72)
BOLD = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 19)
REG = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)


def load(name):
    return Image.open(f'{src}/{name}.png').convert('RGB')


def paint(img, box, fill=None, text=None):
    """Cover a personal value with a solid grey plate marked «скрыто», so it is plainly hidden."""
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, radius=6, fill=(205, 208, 214))
    font = REG if y1 - y0 < 40 else BOLD
    d.text(((x0 + x1) // 2, (y0 + y1) // 2), 'скрыто', fill=(90, 94, 102), font=font, anchor='mm')


def hide_top_bar(img):
    """Kaspi's dark top bar: partner ID and the seller's name sit on its right side."""
    w, h = img.size
    rows = [y for y in range(min(h, 140)) if sum(img.getpixel((1300, y))) < 200]
    if rows:
        ImageDraw.Draw(img).rectangle((1420, rows[0], w, rows[-1]), fill=img.getpixel((1300, rows[len(rows) // 2])))


def frame(img, crop, caption, marks=()):
    part = img.crop(crop)
    scale = min(W / part.width, AREA_H / part.height)
    part = part.resize((round(part.width * scale), round(part.height * scale)), Image.LANCZOS)
    f = Image.new('RGB', (W, H), (245, 246, 248))
    ox, oy = (W - part.width) // 2, (AREA_H - part.height) // 2
    f.paste(part, (ox, oy))
    d = ImageDraw.Draw(f)
    for x0, y0, x1, y1 in marks:
        b = (ox + (x0 - crop[0]) * scale - 6, oy + (y0 - crop[1]) * scale - 6, ox + (x1 - crop[0]) * scale + 6, oy + (y1 - crop[1]) * scale + 6)
        d.rounded_rectangle(b, radius=8, outline=RED, width=4)
    d.rectangle((0, AREA_H, W, H), fill=(17, 24, 39))
    lines, line = [], ''
    for word in caption.split():
        if d.textlength(f'{line} {word}'.strip(), font=BOLD) > W - 40:
            lines.append(line)
            line = word
        else:
            line = f'{line} {word}'.strip()
    lines.append(line)
    y = AREA_H + CAP / 2 - (len(lines) - 1) * 13
    for ln in lines:
        d.text((20, y), ln, fill=(255, 255, 255), font=BOLD, anchor='lm')
        y += 26
    return f


k1, k2, k3, k4 = (load(f'k{i}') for i in range(1, 5))
for k in (k1, k2, k3, k4):
    hide_top_bar(k)
# «Информация о магазине»: partner ID, shop name, logo, phone
for box in [(632, 280, 760, 305), (632, 315, 760, 340), (632, 342, 760, 434), (632, 632, 790, 658)]:
    paint(k3, box)
# «Токен API»: the token itself
paint(k4, (316, 236, 664, 268))

e1, e2 = load('e1'), load('e2')
frames = [
    (frame(k1, (0, 0, 1100, 596), '1. Откройте кабинет продавца Kaspi: kaspi.kz/mc (войдите как руководитель)', [(25, 12, 225, 58)]), 4000),
    (frame(k2, (0, 371, 1013, 920), '2. В меню слева прокрутите вниз и откройте «Настройки»', [(15, 838, 231, 870)]), 4000),
    (frame(k3, (280, 96, 1200, 594), '3. Вверху откройте вкладку «Токен API»', [(1067, 183, 1158, 213)]), 4000),
    (frame(k4, (280, 84, 1200, 582), '4. Нажмите «Скопировать». Токена нет? «Сформировать» — может только руководитель', [(679, 232, 792, 271)]), 5000),
    (frame(e1, (0, 0, 1476, 800), '5. В SaudaPulse нажмите «+ Подключить магазин»', [(12, 754, 227, 780)]), 4000),
    (frame(e2, (0, 0, 1476, 800), '6. Впишите название и вставьте токен в поле «Токен API Kaspi» (Ctrl+V)', [(539, 287, 937, 319), (539, 355, 937, 387)]), 4500),
    (frame(e2, (0, 0, 1476, 800), '7. Нажмите «Подключить» — заказы начнут загружаться сами', [(830, 589, 937, 621)]), 4500),
]
imgs = [f for f, _ in frames]
pal = Image.new('RGB', (W, H * len(imgs)))
for i, f in enumerate(imgs):
    pal.paste(f, (0, H * i))
pal = pal.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in imgs]
q[0].save(out, save_all=True, append_images=q[1:], duration=[ms for _, ms in frames], loop=0, optimize=True, disposal=1)
for i, f in enumerate(imgs):
    f.save(out.replace('.gif', f'-frame{i + 1}.png')) if '--frames' in sys.argv else None
print(out, len(imgs), 'frames')
