-- =====================================================================
--  AgendaBoite - Schéma de base (Supabase / Postgres)
--  Agenda d'équipe + fiches d'intervention client + pont Dolibarr
--  À coller dans : Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PROFILS  (un par membre, lié au compte auth Supabase)
-- ---------------------------------------------------------------------
create table if not exists public.profils (
  id          uuid primary key references auth.users(id) on delete cascade,
  nom         text not null,
  email       text,
  couleur     text not null default '#3b82f6',   -- couleur du membre dans l'agenda
  role        text not null default 'membre'      -- 'admin' | 'manager' | 'membre'
              check (role in ('admin','manager','membre')),
  actif       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. CLIENTS
-- ---------------------------------------------------------------------
create table if not exists public.clients (
  id           uuid primary key default gen_random_uuid(),
  nom          text not null,
  email        text,
  telephone    text,
  adresse      text,
  notes        text,
  dolibarr_id  bigint unique,          -- rowid du tiers côté Dolibarr (null si créé ici)
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. RDV  (le coeur de l'agenda)
-- ---------------------------------------------------------------------
create table if not exists public.rdv (
  id                 uuid primary key default gen_random_uuid(),
  titre              text not null,
  description        text,
  debut              timestamptz not null,
  fin                timestamptz not null,
  assigne_a          uuid references public.profils(id) on delete set null,  -- qui fait le RDV
  client_id          uuid references public.clients(id) on delete set null,
  lieu               text,
  statut             text not null default 'planifie'
                     check (statut in ('planifie','confirme','termine','annule')),
  couleur            text,                    -- override optionnel (sinon = couleur du membre)
  cree_par           uuid references public.profils(id) on delete set null,
  dolibarr_event_id  bigint unique,           -- id de l'événement agenda côté Dolibarr
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (fin >= debut)
);
create index if not exists rdv_debut_idx     on public.rdv (debut);
create index if not exists rdv_assigne_idx   on public.rdv (assigne_a);
create index if not exists rdv_client_idx    on public.rdv (client_id);

-- ---------------------------------------------------------------------
-- 4. INTERVENTIONS  (fiche client : devis, montant, statut, notes)
-- ---------------------------------------------------------------------
create table if not exists public.interventions (
  id                     uuid primary key default gen_random_uuid(),
  rdv_id                 uuid references public.rdv(id) on delete set null,
  client_id              uuid references public.clients(id) on delete set null,
  titre                  text not null,
  description            text,
  montant_devis          numeric(12,2),
  statut                 text not null default 'devis'
                         check (statut in ('devis','en_cours','termine','facture','annule')),
  -- Dossiers en attente : une intervention sans rdv_id est "non planifiée".
  urgence                text not null default 'normale'
                         check (urgence in ('urgent','semaine','normale')),
  notes                  text,
  dolibarr_proposal_id   bigint unique,     -- devis (proposition commerciale) Dolibarr
  dolibarr_fichinter_id  bigint unique,     -- fiche d'intervention Dolibarr (module Fichinter)
  cree_par               uuid references public.profils(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists interv_client_idx on public.interventions (client_id);
create index if not exists interv_rdv_idx     on public.interventions (rdv_id);

-- ---------------------------------------------------------------------
-- 5. PHOTOS d'intervention  (le fichier vit dans Supabase Storage)
-- ---------------------------------------------------------------------
create table if not exists public.intervention_photos (
  id               uuid primary key default gen_random_uuid(),
  intervention_id  uuid not null references public.interventions(id) on delete cascade,
  storage_path     text not null,          -- chemin dans le bucket 'interventions'
  legende          text,
  uploaded_by      uuid references public.profils(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists photos_interv_idx on public.intervention_photos (intervention_id);

-- =====================================================================
--  FONCTIONS UTILITAIRES (pour les droits, sans récursion RLS)
-- =====================================================================

-- Renvoie le rôle du membre connecté. SECURITY DEFINER = contourne la RLS
-- sur profils, ce qui évite la récursion infinie dans les policies.
create or replace function public.mon_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profils where id = auth.uid();
$$;

create or replace function public.est_gestionnaire()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.mon_role() in ('admin','manager'), false);
$$;

-- Met à jour updated_at automatiquement
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists rdv_touch on public.rdv;
create trigger rdv_touch before update on public.rdv
  for each row execute function public.touch_updated_at();

drop trigger if exists interv_touch on public.interventions;
create trigger interv_touch before update on public.interventions
  for each row execute function public.touch_updated_at();

-- Crée automatiquement un profil quand un compte auth est créé
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profils (id, nom, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'nom', split_part(new.email,'@',1)), new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
--  RLS  (Row Level Security) - les droits
-- =====================================================================
alter table public.profils             enable row level security;
alter table public.clients             enable row level security;
alter table public.rdv                 enable row level security;
alter table public.interventions       enable row level security;
alter table public.intervention_photos enable row level security;

-- ---- PROFILS : toute l'équipe se voit ; chacun édite le sien ; admin gère tout
drop policy if exists profils_select on public.profils;
create policy profils_select on public.profils
  for select using (auth.uid() is not null);

drop policy if exists profils_update_self on public.profils;
create policy profils_update_self on public.profils
  for update using (id = auth.uid());

-- filet de sécurité : chacun peut créer SON profil si le trigger n'a pas tourné
drop policy if exists profils_insert_self on public.profils;
create policy profils_insert_self on public.profils
  for insert with check (id = auth.uid());

drop policy if exists profils_admin_all on public.profils;
create policy profils_admin_all on public.profils
  for all using (public.mon_role() = 'admin')
  with check (public.mon_role() = 'admin');

-- ---- CLIENTS : tout le monde lit ; tout le monde crée/édite ; admin/manager supprime
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select using (auth.uid() is not null);

drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients
  for insert with check (auth.uid() is not null);

drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update using (auth.uid() is not null);

drop policy if exists clients_delete on public.clients;
create policy clients_delete on public.clients
  for delete using (public.est_gestionnaire());

-- ---- RDV : toute l'équipe voit tous les agendas.
--       Chacun est maître du sien ; admin/manager modifient ceux de tout le monde.
drop policy if exists rdv_select on public.rdv;
create policy rdv_select on public.rdv
  for select using (auth.uid() is not null);

drop policy if exists rdv_insert on public.rdv;
create policy rdv_insert on public.rdv
  for insert with check (
    public.est_gestionnaire()               -- gestionnaire : RDV pour n'importe qui
    or assigne_a = auth.uid()                -- membre : uniquement pour lui-même
    or assigne_a is null
  );

drop policy if exists rdv_update on public.rdv;
create policy rdv_update on public.rdv
  for update using (
    public.est_gestionnaire() or assigne_a = auth.uid()
  );

drop policy if exists rdv_delete on public.rdv;
create policy rdv_delete on public.rdv
  for delete using (
    public.est_gestionnaire() or assigne_a = auth.uid()
  );

-- ---- INTERVENTIONS : tout le monde lit/crée ; le créateur ou un gestionnaire édite
drop policy if exists interv_select on public.interventions;
create policy interv_select on public.interventions
  for select using (auth.uid() is not null);

drop policy if exists interv_insert on public.interventions;
create policy interv_insert on public.interventions
  for insert with check (auth.uid() is not null);

drop policy if exists interv_update on public.interventions;
create policy interv_update on public.interventions
  for update using (
    public.est_gestionnaire() or cree_par = auth.uid()
  );

drop policy if exists interv_delete on public.interventions;
create policy interv_delete on public.interventions
  for delete using (
    public.est_gestionnaire() or cree_par = auth.uid()
  );

-- ---- PHOTOS : tout le monde lit ; celui qui a uploadé ou un gestionnaire édite/supprime
drop policy if exists photos_select on public.intervention_photos;
create policy photos_select on public.intervention_photos
  for select using (auth.uid() is not null);

drop policy if exists photos_insert on public.intervention_photos;
create policy photos_insert on public.intervention_photos
  for insert with check (auth.uid() is not null);

drop policy if exists photos_delete on public.intervention_photos;
create policy photos_delete on public.intervention_photos
  for delete using (
    public.est_gestionnaire() or uploaded_by = auth.uid()
  );

-- =====================================================================
--  STORAGE : bucket privé pour les photos d'intervention
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('interventions', 'interventions', false)
on conflict (id) do nothing;

drop policy if exists interv_photos_read on storage.objects;
create policy interv_photos_read on storage.objects
  for select using (bucket_id = 'interventions' and auth.uid() is not null);

drop policy if exists interv_photos_write on storage.objects;
create policy interv_photos_write on storage.objects
  for insert with check (bucket_id = 'interventions' and auth.uid() is not null);

drop policy if exists interv_photos_delete on storage.objects;
create policy interv_photos_delete on storage.objects
  for delete using (bucket_id = 'interventions' and auth.uid() is not null);

-- =====================================================================
--  FIN.  Après le premier compte créé, passe-toi admin :
--     update public.profils set role='admin' where email='ton@email.fr';
-- =====================================================================
