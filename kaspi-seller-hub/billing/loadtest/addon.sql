\set n random(1, 50000)
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', md5('u' || :n)::uuid::text, true);
SELECT public.request_store_addon(4) IS NULL;
END;
