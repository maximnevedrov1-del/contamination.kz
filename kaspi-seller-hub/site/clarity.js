// Microsoft Clarity loader (optional; the build emits this file's <script> and the id meta only when
// clarityProjectId is set in site.config.json). External file, so no inline script is needed (CSP-safe).
(() => {
  const id = document.querySelector('meta[name="clarity-id"]')?.content || '';
  if (!/^[a-z0-9]{6,20}$/.test(id)) return;
  window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.clarity.ms/tag/${id}`;
  document.head.append(s);
})();
