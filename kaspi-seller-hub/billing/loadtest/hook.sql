\set n random(1, 50000)
BEGIN;
SET LOCAL ROLE supabase_auth_admin;
SELECT public.custom_access_token_hook(jsonb_build_object('user_id', md5('u' || :n)::uuid, 'claims', '{}'::jsonb)) IS NOT NULL;
END;
