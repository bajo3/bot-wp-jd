-- Follow-ups (scheduled messages)

create table if not exists public.followups (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  step int not null check (step in (1, 2, 3)),
  run_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'canceled')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists followups_lead_status_run_at_idx on public.followups (lead_id, status, run_at);

alter table public.followups enable row level security;

-- admin-only by default (service role bypasses RLS)
do $$ begin
  create policy "followups_select" on public.followups for select using (false);
exception when duplicate_object then null; end $$;
