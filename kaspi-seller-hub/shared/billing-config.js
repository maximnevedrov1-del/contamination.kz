/**
 * Kaspi Seller Hub — subscription server (Supabase project).
 *
 * Fill these two values from Supabase → Project Settings → API:
 *   - Project URL        → supabaseUrl
 *   - anon public key    → supabaseAnonKey   (public by design; access is enforced
 *                                             by Row Level Security in the database)
 * While both are empty the extension runs in DEVELOPER MODE: no login, no limits.
 * Never put the service_role key here.
 */
export const BILLING = Object.freeze({
  supabaseUrl: '',
  supabaseAnonKey: '',
  // How often the licence is re-checked online, and how long a cached licence is
  // trusted while the server cannot be reached.
  refreshMinutes: 10,
  offlineGraceDays: 3,
});
