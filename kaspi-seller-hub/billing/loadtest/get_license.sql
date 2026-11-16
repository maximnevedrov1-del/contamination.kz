\set n random(1, 50000)
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', md5('u' || :n)::uuid::text, true);
SELECT public.get_license(3, array[encode(sha256(convert_to('ksh:' || (:n * 3), 'UTF8')), 'hex'), encode(sha256(convert_to('ksh:' || (:n * 3 + 1), 'UTF8')), 'hex'), encode(sha256(convert_to('ksh:' || (:n * 3 + 2), 'UTF8')), 'hex')]) IS NOT NULL;
END;
