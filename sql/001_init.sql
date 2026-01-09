-- Jesús Díaz Automotores - WhatsApp Bot (Supabase)

-- 1) agentes (vendedores)
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone_e164 text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- cursor de round-robin
create table if not exists public.agent_assignment_cursor (
  id text primary key, -- ej: 'jesus_diaz'
  last_agent_id uuid null references public.agents(id),
  updated_at timestamptz not null default now()
);

-- 2) leads (1 por teléfono)
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  name text null,

  stage text not null default 'new',
  conversation_state text not null default 'START',

  intent text null,
  budget_min numeric null,
  budget_max numeric null,
  budget_text text null,
  car_query text null,
  finance text null,
  trade_in text null,
  urgency text null,
  lead_quality text null,

  assigned_agent_id uuid null references public.agents(id),

  last_user_message_at timestamptz null,
  last_bot_message_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_stage_idx on public.leads(stage);
create index if not exists leads_assigned_idx on public.leads(assigned_agent_id);

-- 3) mensajes (idempotencia por wa_message_id)
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  wa_message_id text null,
  direction text not null,
  text text not null,
  raw_payload jsonb null,
  created_at timestamptz not null default now()
);

create unique index if not exists messages_wa_message_id_uniq on public.messages(wa_message_id)
where wa_message_id is not null;

-- 4) ejecuciones del bot
create table if not exists public.bot_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  extracted jsonb null,
  decision text not null,
  model_used text null,
  created_at timestamptz not null default now()
);

-- 5) training examples
create table if not exists public.training_examples (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid null references public.leads(id) on delete set null,
  user_message text not null,
  bot_message text not null,
  extracted jsonb null,
  ideal_response text null,
  is_good boolean null,
  created_at timestamptz not null default now()
);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
before update on public.leads
for each row execute function public.set_updated_at();
