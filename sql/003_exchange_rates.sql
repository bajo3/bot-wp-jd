-- Exchange rates cache (USD blue)

create table if not exists public.exchange_rates (
  id text primary key,
  sell numeric not null,
  buy numeric,
  source text,
  updated_at timestamptz not null default now()
);

create index if not exists exchange_rates_updated_at_idx on public.exchange_rates (updated_at desc);

alter table public.exchange_rates enable row level security;

-- admin-only by default (service role bypasses RLS)
do $$ begin
  create policy "exchange_rates_select" on public.exchange_rates for select using (false);
exception when duplicate_object then null; end $$;
