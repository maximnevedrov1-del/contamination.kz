// Cloudflare Worker entry (alternative to the Supabase Edge Function; same handler, same rules).
//   wrangler deploy billing/supabase/functions/kaspi-relay/worker.js --name saudapulse-kaspi-relay
//   vars: SUPABASE_URL=https://<project>.supabase.co  RELAY_ALLOWED_ORIGINS=https://saudapulse.kz
// Keep Workers «Logs» / Logpush OFF for this worker: the handler writes nothing, but request
// tracing on the Cloudflare side would record headers.
import { createRelay } from './handler.js';

let handle = null;
export default {
  fetch(req, env) {
    handle ??= createRelay({ env });
    return handle(req);
  },
};
