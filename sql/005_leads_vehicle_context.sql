-- Lead context for vehicle suggestions / selection

alter table public.leads
  add column if not exists budget_currency text,
  add column if not exists last_vehicle_suggestions jsonb,
  add column if not exists selected_vehicle jsonb,
  add column if not exists selected_vehicle_id text;

-- (Optional) small index for quick lookups
create index if not exists leads_selected_vehicle_id_idx on public.leads (selected_vehicle_id);
