// Supabase Edge Function entry (deployed to kaspi-seller-hub with verify_jwt = false):
//   supabase functions deploy kaspi-relay --no-verify-jwt
// Allowed pages: handler.js DEFAULT_ORIGINS (saudapulse.kz, www, saudapulse.pages.dev);
// RELAY_ALLOWED_ORIGINS overrides it when set.
// --no-verify-jwt: the gateway's own check would refuse the browser's CORS preflight; the function
// verifies the user's access token itself (ES256 against the project's public keys) on every call.
// Stateless: no database, no logs (see handler.js).
import { createRelay } from './handler.js';

const handle = createRelay({ env: Deno.env.toObject() });
Deno.serve(handle);
