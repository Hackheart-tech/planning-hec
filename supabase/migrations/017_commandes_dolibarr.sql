-- =====================================================================
--  017 - Affaires à faire auto depuis les COMMANDES Dolibarr (admins only)
--  Quand un devis est transformé en commande validée dans Dolibarr, un
--  robot (fonction cron job=orders) crée une "affaire à faire" (intervention
--  sans rdv_id) visible UNIQUEMENT des admins, annotée "Devis validé",
--  avec le client rattaché (donc toutes ses coordonnées).
-- =====================================================================

alter table public.interventions add column if not exists dolibarr_order_id bigint;
create unique index if not exists interventions_dolibarr_order_id_uniq
  on public.interventions (dolibarr_order_id) where dolibarr_order_id is not null;
alter table public.interventions add column if not exists origine text;          -- ex : 'dolibarr_commande'
alter table public.interventions add column if not exists admin_seulement boolean not null default false;

-- Helper : l'appelant est-il admin ?
create or replace function public.est_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profils where id = auth.uid()), false);
$$;

-- Confidentialité : un dossier "admin_seulement" n'est lisible que par un admin.
drop policy if exists interv_select on public.interventions;
create policy interv_select on public.interventions for select using (
  public.est_valide() and (admin_seulement = false or public.est_admin())
);

-- Petite config technique (watermark des commandes déjà vues, etc.).
-- Accès service_role uniquement (RLS active, aucune policy = tout refusé au front).
create table if not exists public.app_config (
  cle text primary key,
  valeur text
);
alter table public.app_config enable row level security;

-- NB : le job planifié quotidien 'agendaboite-commandes' (pg_cron -> fonction
-- cron job=orders) est créé à part avec la vraie valeur du secret CRON_SECRET
-- (comme la migration 012), jamais committée ici.
