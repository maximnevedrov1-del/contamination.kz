# How the help GIFs are made

`help/*.gif` are recorded from the real interface on demo data, so they can be re-made
whenever the interface changes:

1. Copy the extension, point `shared/selectors.js` (`api.base`, `api.productsBase`) at
   `http://localhost:8099/…` in the copy, and set `EXT` / `OUT` in `gifs.js`.
2. `node mockapi.js` (fake Kaspi API), then `node gifs.js` (Playwright: clicks through five
   scenarios, saves frames with captions and click markers).
3. `python3 gifs.py <frames dir> ../../help` (Pillow: 840×525, shared palette).

Captions are in Russian. Never record on a real store: buyers' data must not get into the clips.
