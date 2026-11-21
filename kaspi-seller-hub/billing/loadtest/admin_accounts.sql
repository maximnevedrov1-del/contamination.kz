BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', md5('u1')::uuid::text, true);
SELECT public.admin_accounts(null, 'all', 100, 0) IS NOT NULL;
END;
