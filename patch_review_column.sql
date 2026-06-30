-- ============================================================
-- Patch: review email tracking column
-- ============================================================

alter table public.jobs
  add column if not exists review_email_sent boolean not null default false;

-- Verify
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'jobs' and column_name = 'review_email_sent';
