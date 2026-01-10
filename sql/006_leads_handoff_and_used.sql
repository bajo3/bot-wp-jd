-- Bot fixes: handoff tracking + used vehicle details + session reset timestamp

alter table public.leads
  add column if not exists handed_off_at timestamptz,
  add column if not exists handed_off_notified_at timestamptz,
  add column if not exists last_reset_at timestamptz,
  add column if not exists used_vehicle_text text;

create index if not exists leads_handed_off_at_idx on public.leads (handed_off_at);
create index if not exists leads_last_reset_at_idx on public.leads (last_reset_at);
