/**
 * Dashboard wiring for the anonymous UX tracker (shared/ux-telemetry.js).
 * Reads ONLY: element.dataset.uxKey, dialog ids marked data-ux-form, the route id and dialog returnValue.
 * Never innerText / textContent / value / URLs / page content.
 */
import { createUxTracker, normalizeKey } from '../shared/ux-telemetry.js';

export function startUx({ enabled = () => true } = {}) {
  const tracker = createUxTracker({
    send: (events) => (enabled() ? chrome.runtime.sendMessage({ type: 'ui:trackUx', payload: { events } }) : undefined),
  });
  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-ux-key]');
    if (el && enabled()) tracker.click(el.dataset.uxKey);
  }, true);
  // dialogs marked data-ux-form: opened → closed without «ok» after 15 s = abandoned form
  new MutationObserver((list) => {
    for (const m of list) {
      const d = m.target;
      if (d?.tagName !== 'DIALOG' || d.dataset?.uxForm == null) continue;
      const key = normalizeKey(d.id);
      if (!key) continue;
      if (d.open) tracker.formOpened(key);
      else if (enabled()) tracker.formClosed(key, d.returnValue === 'ok');
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  addEventListener('pagehide', () => tracker.flush());
  document.addEventListener('visibilitychange', () => document.hidden && tracker.flush());
  return tracker;
}
