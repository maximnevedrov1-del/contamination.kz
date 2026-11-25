/**
 * SaudaPulse phone app — configuration. The Supabase project, anon key and licence signing keys
 * come from the extension's own shared/billing-config.js (one source of truth).
 */
import { BILLING } from '../core/shared/billing-config.js';
import { relayUrlFor } from '../core/shared/kaspi-relay-client.js';

export const APP_VERSION = '0.1.0';
/** Cloudflare Turnstile «Site Key» (public). The build replaces the placeholder; left as is → no captcha. */
export const TURNSTILE_SITE_KEY = '__TURNSTILE_SITE_KEY__';
export const turnstileOn = () => /^0x[0-9A-Za-z_-]{10,}$/.test(TURNSTILE_SITE_KEY);
export const RELAY_URL = relayUrlFor(BILLING.supabaseUrl);
export const ANON_KEY = BILLING.supabaseAnonKey;
/** How often a packer's access is re-checked, and how long they may work without an answer. */
export const STAFF_CHECK_MS = 2 * 60000;
export const STAFF_OFFLINE_GRACE_MS = 5 * 60000;
/** Orders re-read automatically while the app is open. */
export const AUTO_SYNC_MS = 3 * 60000;
