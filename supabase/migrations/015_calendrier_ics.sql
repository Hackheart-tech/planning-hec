-- =====================================================================
--  015 - Abonnement calendrier (flux iCalendar / webcal)
--  Chaque utilisateur possède un jeton secret personnel. Il l'utilise
--  dans l'URL webcal pour s'abonner au planning de l'équipe depuis
--  Google Agenda / l'app Calendrier du téléphone. Le flux est généré
--  par la fonction edge "calendar-feed" (lecture seule).
-- =====================================================================

create table if not exists public.cal_abonnements (
  profil_id uuid primary key references public.profils(id) on delete cascade,
  token     uuid not null default gen_random_uuid(),
  cree_le   timestamptz not null default now()
);
create unique index if not exists cal_abonnements_token_unique
  on public.cal_abonnements (token);

alter table public.cal_abonnements enable row level security;

-- Chacun ne voit QUE son propre jeton (le jeton d'un autre = accès à son flux).
drop policy if exists cal_select_self on public.cal_abonnements;
create policy cal_select_self on public.cal_abonnements
  for select using (profil_id = auth.uid());

-- Récupère (en le créant au besoin) le jeton d'abonnement de l'appelant.
create or replace function public.mon_cal_token()
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'non authentifie'; end if;
  insert into public.cal_abonnements (profil_id)
    values (auth.uid())
    on conflict (profil_id) do nothing;
  select token into t from public.cal_abonnements where profil_id = auth.uid();
  return t;
end; $$;

-- Régénère le jeton (invalide l'ancien lien d'abonnement).
create or replace function public.regenerer_cal_token()
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'non authentifie'; end if;
  insert into public.cal_abonnements (profil_id, token)
    values (auth.uid(), gen_random_uuid())
    on conflict (profil_id) do update set token = gen_random_uuid(), cree_le = now();
  select token into t from public.cal_abonnements where profil_id = auth.uid();
  return t;
end; $$;

grant execute on function public.mon_cal_token() to authenticated;
grant execute on function public.regenerer_cal_token() to authenticated;

-- Jeton pour les comptes déjà existants.
insert into public.cal_abonnements (profil_id)
  select id from public.profils
  on conflict (profil_id) do nothing;
