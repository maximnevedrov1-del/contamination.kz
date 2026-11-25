# saudapulse.kz — the site as uploaded

Built by `node tools/build-app.mjs && node tools/build-site-package.mjs` (output `dist/site-package/`, copied here
so the version that goes live is kept in git). Upload the contents of this folder as they are
(Cloudflare Pages → Upload assets). `README.md` itself is harmless on the site.

2026-11-25: landing fixed for phones and tablets (headline, lead text and buttons no longer run off the
screen at 320–430 px; header at 768 px), «Установить» on every landing page, phone app at /app.
