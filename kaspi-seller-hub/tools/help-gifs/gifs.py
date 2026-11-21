import json, os, sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
for scene in sorted(os.listdir(src)):
    d = os.path.join(src, scene)
    meta = json.load(open(os.path.join(d, 'frames.json')))
    frames = [Image.open(os.path.join(d, m['file'])).convert('RGB').resize((840, 525), Image.LANCZOS) for m in meta]
    # one shared palette → small file, no colour flicker between frames
    pal = Image.new('RGB', (840, 525 * len(frames)))
    for i, f in enumerate(frames): pal.paste(f, (0, 525 * i))
    pal = pal.quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    out = os.path.join(dst, scene + '.gif')
    q[0].save(out, save_all=True, append_images=q[1:], duration=[m['ms'] for m in meta], loop=0, optimize=True, disposal=1)
    print(scene, len(frames), 'frames', round(os.path.getsize(out) / 1024), 'KB', sum(m['ms'] for m in meta) / 1000, 's')
