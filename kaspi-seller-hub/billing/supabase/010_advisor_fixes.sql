-- 010_advisor_fixes.sql
-- Run after 009_billing_revoke_fix.sql.
-- Supabase advisor fixes (2026-11-21):
--  1. function_search_path_mutable: pin search_path on the 12 helper functions. Their bodies use
--     public.-qualified names and pg_catalog built-ins only, so an empty search_path is safe.
--  2. auth_rls_initplan: accounts_read_own / invoices_read_own use (select auth.uid()); logic unchanged.
--  3. unindexed_foreign_keys: index for api_health_user_id_fkey.
begin;

alter function public.ticket_json(public.support_tickets, boolean) set search_path = '';
alter function public.discounted(integer, public.accounts) set search_path = '';
alter function public.discount_now(public.accounts) set search_path = '';
alter function public.grace_until(public.accounts) set search_path = '';
alter function public.coverage_end(public.accounts) set search_path = '';
alter function public.phone_or_account(text, public.accounts) set search_path = '';
alter function public.normalize_phone(text) set search_path = '';
alter function public.team_row(public.team_members) set search_path = '';
alter function public.clean_shop_ids(text[]) set search_path = '';
alter function public.outage_fails(jsonb) set search_path = '';
alter function public.insight_keys(text) set search_path = '';
alter function public.add_counts(jsonb, jsonb, text) set search_path = '';

drop policy if exists accounts_read_own on public.accounts;
create policy accounts_read_own on public.accounts for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists invoices_read_own on public.invoices;
create policy invoices_read_own on public.invoices for select to authenticated
  using (user_id = (select auth.uid()));

create index if not exists api_health_user on public.api_health (user_id);

commit;
