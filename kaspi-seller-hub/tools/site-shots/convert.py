"""Screenshots (raw/*.png, 2× retina) → WebP for the landing page (site/assets/)."""
import os, sys
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
RAW, OUT = os.path.join(HERE, 'raw'), os.path.join(HERE, '../../site/assets')
JOBS = {  # name: (max width, crop box in raw pixels or None)
    'home': (1600, None),
    'orders': (1600, None),
    'analytics': (1600, (0, 0, 2880, 1800)),
    'catalog': (1600, None),
    'order-card': (1000, None),
    'picklist': (1000, None),
    'print-card': (1200, None),
}
for name, (w, box) in JOBS.items():
    im = Image.open(os.path.join(RAW, f'{name}.png')).convert('RGB')
    if box: im = im.crop(box)
    if im.width > w: im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    path = os.path.join(OUT, f'{name}.webp')
    im.save(path, 'WEBP', quality=82, method=6)
    print(name, im.size, os.path.getsize(path) // 1024, 'KB')
