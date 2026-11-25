-- Seller Hub: bot_faq also callable with p_chat_id. Safe to run again. Apply AFTER 032_support_bot.sql.
-- The bot deployed on 25.11 (v12) called bot_faq(p_key, p_chat_id); PostgREST matches functions by argument
-- names, so the call failed and the bot fell back to its short help. bot.js now calls bot_faq(p_key); this
-- overload keeps a bot of either version working. Same answer, the chat is ignored.
create or replace function public.bot_faq(p_key text, p_chat_id bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.bot_faq(p_key);
$$;
revoke execute on function public.bot_faq(text, bigint) from public, anon, authenticated;
grant execute on function public.bot_faq(text, bigint) to service_role;
notify pgrst, 'reload schema';
