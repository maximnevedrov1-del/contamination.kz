// Supabase Edge Function entry: deploy with
//   supabase functions deploy payment-webhook --no-verify-jwt
// (the payment service does not send a Supabase token; every request is checked by its own signature).
import { handle } from './handler.js';

Deno.serve((req) => handle(req, Deno.env.toObject()));
