-- ============================================================
-- pending_orders: captures artwork submissions before Shopify checkout
-- ============================================================

create table if not exists public.pending_orders (
  id            uuid default gen_random_uuid() primary key,
  email         text not null,
  name          text,
  phone         text,
  product_type  text,
  shape         text,
  width_mm      numeric,
  height_mm     numeric,
  material      text,
  laminate      text,
  quantity      integer,
  notes         text,
  artwork_url   text,
  artwork_filename text,
  source_page   text,   -- which configurator page (rolls, sheets, individual, etc.)
  raw_fields    jsonb,  -- full form payload for reference
  matched_job_id text references public.jobs(id),
  matched_at    timestamptz,
  created_at    timestamptz default now()
);

-- Index on email for fast lookup at webhook time
create index if not exists pending_orders_email_idx on public.pending_orders (email);
create index if not exists pending_orders_matched_idx on public.pending_orders (matched_job_id);

-- RLS
alter table public.pending_orders enable row level security;

create policy "Team can read pending orders"
  on public.pending_orders for select to authenticated using (true);

create policy "Service role can insert pending orders"
  on public.pending_orders for insert to authenticated with check (true);

create policy "Service role can update pending orders"
  on public.pending_orders for update to authenticated using (true);

-- Storage bucket for pending artwork (if not already created)
insert into storage.buckets (id, name, public)
values ('pending-artwork', 'pending-artwork', false)
on conflict (id) do nothing;
