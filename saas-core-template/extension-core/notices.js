// Pure helpers for the dashboard banners (no DOM, no chrome.*): unit-testable.
const TYPES = ['info', 'warn', 'danger'];

/** The owner's system banner from a licence view: {active:true,text,type} or null when nothing to show. */
export function bannerFrom(view) {
  const b = view && typeof view === 'object' ? view.systemBanner : null;
  if (!b || typeof b !== 'object' || b.active !== true) return null;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return null;
  return { text: text.slice(0, 300), type: TYPES.includes(b.type) ? b.type : 'info' };
}

/** «Subscription / trial ends in 1–3 days»: {days, kind:'trial'|'paid'} or null. A pending cancellation still reminds. */
export function expiryNotice(view) {
  if (!view || typeof view !== 'object') return null;
  const days = Number(view.daysLeft);
  if (!Number.isFinite(days) || days <= 0 || days > 3) return null;
  if (view.status === 'trial') return { days, kind: 'trial' };
  if (view.status === 'active') return { days, kind: 'paid' };
  return null;
}
