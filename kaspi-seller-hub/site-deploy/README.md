# saudapulse.kz — the site as published (Cloudflare Pages project «saudapulse» deploys this folder)

Built by `node tools/build-app.mjs && node tools/build-site-package.mjs` (output `dist/site-package/`, copied here).

- `/` — the landing made in Manus (`site-landing/index.html`, editable sources in `site-landing/source/`),
  Russian and Kazakh in one page (`/?lang=kk`; the old `/kk/` address redirects there).
- `/offer`, `/privacy`, `/legal` — legal pages; `/captcha` — Turnstile page for the extension.
- `/app` — the phone app (PWA). `/install-button.js` — «Установить» on every page:
  computer → the landing's own install button logic (extension / store / #install section),
  phone and tablet → `/app/?install=1` (also the landing's own «Установить бесплатно» buttons).
