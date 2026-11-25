/**
 * QR scanner inside the app (the code never passes through another app or a server).
 * Android Chrome: the browser's own BarcodeDetector. iPhone / others: vendored jsQR on video frames.
 * Resolves the text, or null when closed. «Нет камеры?» lets the user paste the text instead.
 */
import { h } from '../../shared/utils.js';

let jsqrP = null;
const loadJsQR = () =>
  (jsqrP ??= new Promise((ok, fail) => {
    if (globalThis.jsQR) return ok(globalThis.jsQR);
    const s = document.createElement('script');
    s.src = new URL('../vendor/jsQR.js', import.meta.url).href;
    s.onload = () => (globalThis.jsQR ? ok(globalThis.jsQR) : fail(new Error('jsQR')));
    s.onerror = () => fail(new Error('jsQR'));
    document.head.append(s);
  }).catch((e) => ((jsqrP = null), Promise.reject(e))));

async function detectorFor() {
  try {
    if ('BarcodeDetector' in globalThis && (await globalThis.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      const d = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
      return async (video) => (await d.detect(video).catch(() => []))[0]?.rawValue || null;
    }
  } catch { /* fall through */ }
  const jsQR = await loadJsQR();
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth;
    const hgt = video.videoHeight;
    if (!w || !hgt) return null;
    const scale = Math.min(1, 800 / Math.max(w, hgt));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(hgt * scale);
    g.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
  };
}

/** @param {{ title: string, hint: string, accept?: (text:string)=>boolean }} opts */
export function scanQr({ title, hint, accept = () => true }) {
  return new Promise((resolve) => {
    let stream = null;
    let done = false;
    const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scanner__video', 'aria-label': 'Камера' });
    const status = h('p', { class: 'muted small', role: 'status' }, 'Включаем камеру…');
    const paste = h('textarea', { class: 'scanner__paste', rows: 3, placeholder: 'SP1.…', 'aria-label': 'Код с экрана компьютера', dataset: { field: 'qr-paste' } });
    const dlg = h('dialog', { class: 'sheet scanner', 'aria-label': title });
    const finish = (v) => {
      if (done) return;
      done = true;
      stream?.getTracks().forEach((t) => t.stop());
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.append(
      h('h2', { class: 'sheet__title' }, title),
      h('p', { class: 'muted' }, hint),
      h('div', { class: 'scanner__frame' }, video, h('span', { class: 'scanner__aim', 'aria-hidden': 'true' })),
      status,
      h('details', { class: 'scanner__alt' }, h('summary', null, 'Нет камеры? Вставить код'), paste, h('button', { type: 'button', class: 'btn btn--block', dataset: { action: 'qr-paste-ok' }, onclick: () => paste.value.trim() && finish(paste.value.trim()) }, 'Готово')),
      h('div', { class: 'sheet__actions' }, h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => finish(null) }, 'Закрыть')),
    );
    dlg.addEventListener('cancel', (e) => (e.preventDefault(), finish(null)));
    document.body.append(dlg);
    dlg.showModal();
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (done) return stream.getTracks().forEach((t) => t.stop());
        video.srcObject = stream;
        await video.play().catch(() => {});
        status.textContent = 'Наведите камеру на QR-код на экране компьютера';
        const detect = await detectorFor();
        while (!done) {
          const text = await detect(video).catch(() => null);
          if (text && accept(text)) return finish(text);
          await new Promise((r) => setTimeout(r, 150));
        }
      } catch {
        if (!done) status.textContent = 'Камера недоступна. Разрешите доступ к камере в настройках браузера или вставьте код ниже.';
      }
    })();
  });
}
