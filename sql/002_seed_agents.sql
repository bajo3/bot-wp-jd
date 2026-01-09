-- Seed de vendedores + cursor
insert into public.agents (name, phone_e164)
values
  ('Vendedor 1', '+5492494621182'),
  ('Vendedor 2', '+5492494587046')
on conflict (phone_e164) do nothing;

insert into public.agent_assignment_cursor (id)
values ('jesus_diaz')
on conflict (id) do nothing;
