-- OPTIONAL, administrator only. Do not apply if service_role already has UPDATE.
-- This is a permission command, NOT a schema/constraint/RLS migration.
-- Check before applying:
SELECT has_table_privilege('service_role', 'public.bookings', 'UPDATE') AS table_update,
       has_column_privilege('service_role', 'public.bookings', 'status', 'UPDATE') AS status_update;
-- Run separately ONLY if the existing role lacks the required update permission:
-- GRANT UPDATE ON TABLE public.bookings TO service_role;
-- Narrower alternative sufficient for this implementation:
-- GRANT UPDATE (status) ON TABLE public.bookings TO service_role;
-- No grants to anon/authenticated/PUBLIC. No DELETE, RLS or exclusion changes.
