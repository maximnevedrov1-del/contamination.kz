// Supabase Edge Function entry. Deploy to a NEW / staging project first, then production:
//   supabase functions deploy kaspi-relay --no-verify-jwt
//   supabase secrets set RELAY_ALLOWED_ORIGINS=https://saudapulse.kz
// --no-verify-jwt: the gateway's own check would refuse the browser's CORS preflight; the function
// verifies the user's access token itself (ES256 against the project's public keys) on every call.
// Stateless: no database, no logs (see handler.js).
import { createRelay } from './handler.js';

const handle = createRelay({ env: Deno.env.toObject() });
Deno.serve(handle);
