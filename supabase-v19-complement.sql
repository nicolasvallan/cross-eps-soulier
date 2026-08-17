-- =========================================================
-- CROSS EPS V19 - Complément Supabase
-- À exécuter APRÈS le grand script de création de la base.
-- =========================================================

create table if not exists public.app_state (
  event_id uuid primary key references public.cross_events(id) on delete cascade,
  version bigint not null default 0,
  state jsonb not null default jsonb_build_object(
    'students', '[]'::jsonb,
    'races', '[]'::jsonb,
    'checkpoints', '[]'::jsonb,
    'startGroups', '[]'::jsonb,
    'events', '[]'::jsonb,
    'resultArchives', '[]'::jsonb
  ),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.app_state enable row level security;

drop policy if exists "admin manages app state" on public.app_state;
create policy "admin manages app state"
on public.app_state
for all
to authenticated
using (public.is_app_admin())
with check (public.is_app_admin());

drop policy if exists "members view app state" on public.app_state;
create policy "members view app state"
on public.app_state
for select
to authenticated
using (
  public.is_event_member(event_id)
  or public.is_app_admin()
);

create or replace function public.claim_app_admin()
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Authentification nécessaire';
  end if;

  select lower(email)
  into v_email
  from auth.users
  where id = auth.uid();

  if v_email <> 'eps.applicationsnico@gmail.com' then
    raise exception 'Compte non autorisé';
  end if;

  insert into public.app_admins(user_id)
  values(auth.uid())
  on conflict(user_id) do nothing;

  return true;
end;
$$;

grant execute on function public.claim_app_admin() to authenticated;

create or replace function public.save_app_state(
  p_event_id uuid,
  p_expected_version bigint,
  p_state jsonb
)
returns table (
  saved boolean,
  version bigint,
  state jsonb,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.app_state%rowtype;
  v_allowed boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentification nécessaire';
  end if;

  v_allowed :=
    public.is_app_admin()
    or public.is_event_member(p_event_id);

  if not v_allowed then
    raise exception 'Accès refusé';
  end if;

  select *
  into v_row
  from public.app_state
  where event_id = p_event_id
  for update;

  if v_row.event_id is null then
    if not public.is_app_admin() then
      raise exception 'État de course inexistant';
    end if;

    insert into public.app_state(event_id,state,updated_by)
    values(p_event_id,p_state,auth.uid())
    returning * into v_row;

    return query
    select true,v_row.version,v_row.state,v_row.updated_at;
    return;
  end if;

  if v_row.version <> p_expected_version then
    return query
    select false,v_row.version,v_row.state,v_row.updated_at;
    return;
  end if;

  update public.app_state
  set
    state = p_state,
    version = version + 1,
    updated_at = now(),
    updated_by = auth.uid()
  where event_id = p_event_id
  returning * into v_row;

  return query
  select true,v_row.version,v_row.state,v_row.updated_at;
end;
$$;

grant execute
on function public.save_app_state(uuid,bigint,jsonb)
to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='app_state'
  ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end $$;
