// Remote feature flags (UX gating only — not signed, not a security boundary).
// The flags arrive in get_license().features and are cached with the licence under 'ksh.license'.
// No DOM, no window: works in the service worker, dashboard and popup.
const LICENSE_KEY = 'ksh.license';

/** Pure: the boolean value of `key` in `features`, else `fallback`. */
export function featureFrom(features, key, fallback = false) {
  return features && typeof features === 'object' && typeof features[key] === 'boolean' ? features[key] : fallback;
}

/** Cached flags as a plain object; {} when there is no cache, no `features` (old cache) or storage fails. */
export async function getFeatures() {
  try {
    const f = (await chrome.storage.local.get(LICENSE_KEY))?.[LICENSE_KEY]?.data?.features;
    return f && typeof f === 'object' && !Array.isArray(f) ? f : {};
  } catch {
    return {};
  }
}

/** Is the flag on for this user? Never throws; `fallback` when unknown. */
export async function isFeatureEnabled(flagKey, fallback = false) {
  try {
    return featureFrom(await getFeatures(), flagKey, fallback);
  } catch {
    return fallback;
  }
}
