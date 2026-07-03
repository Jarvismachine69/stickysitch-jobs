-- ============================================================
-- StickySitch Job Board — Full Reset
-- Clears all jobs, customers, proofs and notes.
-- Run in Supabase SQL Editor.
-- ⚠ This is irreversible. Run only when you want a clean slate.
-- ============================================================

-- Disable triggers temporarily to avoid FK cascade issues
SET session_replication_role = replica;

-- Clear in dependency order (children first)
TRUNCATE TABLE public.status_history  CASCADE;
TRUNCATE TABLE public.job_notes       CASCADE;
TRUNCATE TABLE public.proofs          CASCADE;
TRUNCATE TABLE public.job_items       CASCADE;
TRUNCATE TABLE public.jobs            CASCADE;
TRUNCATE TABLE public.customers       CASCADE;

-- Re-enable triggers
SET session_replication_role = DEFAULT;

-- Verify everything is empty
SELECT 'jobs'           AS table_name, COUNT(*) AS rows FROM public.jobs
UNION ALL
SELECT 'customers',                    COUNT(*)         FROM public.customers
UNION ALL
SELECT 'job_items',                    COUNT(*)         FROM public.job_items
UNION ALL
SELECT 'proofs',                       COUNT(*)         FROM public.proofs
UNION ALL
SELECT 'job_notes',                    COUNT(*)         FROM public.job_notes
UNION ALL
SELECT 'status_history',               COUNT(*)         FROM public.status_history;
