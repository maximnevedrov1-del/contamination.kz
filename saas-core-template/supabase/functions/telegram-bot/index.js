// Supabase Edge Function entry: deploy with
//   supabase functions deploy telegram-bot --no-verify-jwt
// (Telegram and the scheduler do not send a Supabase token; every route checks its own secret,
// and /alert passes the seller's token on to the database, which checks it.)
import { handle } from './bot.js';

Deno.serve((req) => handle(req, Deno.env.toObject()));
