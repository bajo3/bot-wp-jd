-- Agent outbox: pending notifications for sellers (provider-agnostic)
-- This is consumed by a worker (n8n/cron/edge function) that actually sends the message.

create table if not exists public.agent_outbox (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  payload jsonb not null,
  status text not null default 'pending', -- pending | sent | failed
  error text null,
  created_at timestamptz not null default now(),
  sent_at timestamptz null
);

create index if not exists agent_outbox_status_idx on public.agent_outbox(status);
create index if not exists agent_outbox_agent_id_idx on public.agent_outbox(agent_id);
create index if not exists agent_outbox_lead_id_idx on public.agent_outbox(lead_id);
