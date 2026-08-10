-- ============================================================
-- OPTIONAL patch: production stage / priority / owner
-- ------------------------------------------------------------
-- The redesigned board uses a 12-stage production workflow that
-- is finer-grained than the legacy `status` column. This patch
-- adds THREE nullable columns so the finer stage, priority and
-- owner can be persisted. Nothing here changes existing data or
-- breaks any existing logic:
--   • `status`  is still written on every stage change (mapped),
--     so the Shopify webhook, active_jobs view, archive-fulfilled
--     cron and all other backend code keep working unchanged.
--   • `stage`, `priority`, `assigned_to` are additive extras.
--
-- The board works WITHOUT this patch (it derives stage/priority
-- from status + artwork + due date). Run it to make the finer
-- kanban columns and priority flags stick between reloads.
--
-- Safe to run more than once.
-- ============================================================

alter table public.jobs
  add column if not exists stage          text,
  add column if not exists priority       text,
  add column if not exists assigned_to    text,
  add column if not exists artwork_review  boolean not null default false;
-- artwork_review = raised by the Shopify webhook when a paid order arrives
-- with an artwork indication but no uploaded file matched by email. The
-- board also detects this live, so the column is optional.

-- Backfill `stage` from the existing status the first time only.
update public.jobs set stage = case
    when status = 'new'        and artwork_url is null then 'art_pending'
    when status = 'new'                                then 'art_received'
    when status = 'prepress'                           then 'art_check'
    when status = 'revision'                           then 'art_check'
    when status = 'awaiting'                            then 'awaiting'
    when status = 'print'                              then 'printing'
    when status = 'outsource'                          then 'printing'
    when status = 'lam'                               then 'finishing'
    when status = 'cut'                               then 'finishing'
    when status = 'qa'                                then 'qc'
    when status = 'ready'                              then 'ready'
    when status = 'dispatched'                         then 'completed'
    when status = 'pickedup'                           then 'completed'
    when status = 'hold'                              then 'hold'
    when status = 'cancelled'                          then 'cancelled'
    else 'new'
  end
where stage is null;

-- Index for faster stage grouping on the board.
create index if not exists jobs_stage_idx on public.jobs (stage);

-- Verify
select column_name, data_type
from information_schema.columns
where table_name = 'jobs' and column_name in ('stage','priority','assigned_to')
order by column_name;
