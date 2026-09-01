-- =====================================================================
--  002 - Validation des membres par un admin + couleurs uniques
-- =====================================================================

-- 1. Colonne "valide" : un nouveau membre est en attente tant qu'un admin
--    ne l'a pas validé. On valide d'office les comptes déjà existants.
alter table public.profils add column if not exists valide boolean not null default false;
update public.profils set valide = true;

-- 2. Couleur : nullable, sans valeur par défaut, et UNIQUE.
--    Les nouveaux arrivent sans couleur ; l'admin en attribue une libre.
alter table public.profils alter column couleur drop default;
alter table public.profils alter column couleur drop not null;

-- attribue une couleur distincte aux comptes déjà existants (palette dans l'ordre d'inscription)
with pal as (
  select * from unnest(array[
    '#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#f97316',
    '#6366f1','#84cc16','#06b6d4','#d946ef','#eab308','#22c55e','#0ea5e9','#f43f5e'
  ]) with ordinality as p(couleur, ord)
),
num as (
  select id, row_number() over (order by created_at) as rn from public.profils
)
update public.profils pr
set couleur = pal.couleur
from num join pal on pal.ord = num.rn
where pr.id = num.id;

create unique index if not exists profils_couleur_unique
  on public.profils (couleur) where couleur is not null;

-- 3. Un membre est "actif" pour l'appli s'il est validé (ou admin).
create or replace function public.est_valide()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select valide or role = 'admin' from public.profils where id = auth.uid()), false);
$$;

-- 4. PROFILS : chacun lit toujours le sien ; les validés voient l'équipe.
drop policy if exists profils_select on public.profils;
drop policy if exists profils_select_self on public.profils;
create policy profils_select_self on public.profils
  for select using (id = auth.uid());
drop policy if exists profils_select_equipe on public.profils;
create policy profils_select_equipe on public.profils
  for select using (public.est_valide());

-- 5. Toutes les données métier exigent désormais un compte validé.
drop policy if exists rdv_select on public.rdv;
create policy rdv_select on public.rdv for select using (public.est_valide());
drop policy if exists rdv_insert on public.rdv;
create policy rdv_insert on public.rdv for insert with check (
  public.est_valide() and (public.est_gestionnaire() or assigne_a = auth.uid() or assigne_a is null)
);
drop policy if exists rdv_update on public.rdv;
create policy rdv_update on public.rdv for update using (
  public.est_valide() and (public.est_gestionnaire() or assigne_a = auth.uid())
);
drop policy if exists rdv_delete on public.rdv;
create policy rdv_delete on public.rdv for delete using (
  public.est_valide() and (public.est_gestionnaire() or assigne_a = auth.uid())
);

drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select using (public.est_valide());
drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert with check (public.est_valide());
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update using (public.est_valide());

drop policy if exists interv_select on public.interventions;
create policy interv_select on public.interventions for select using (public.est_valide());
drop policy if exists interv_insert on public.interventions;
create policy interv_insert on public.interventions for insert with check (public.est_valide());
drop policy if exists interv_update on public.interventions;
create policy interv_update on public.interventions for update using (
  public.est_valide() and (public.est_gestionnaire() or cree_par = auth.uid())
);
drop policy if exists interv_delete on public.interventions;
create policy interv_delete on public.interventions for delete using (
  public.est_valide() and (public.est_gestionnaire() or cree_par = auth.uid())
);

drop policy if exists photos_select on public.intervention_photos;
create policy photos_select on public.intervention_photos for select using (public.est_valide());
drop policy if exists photos_insert on public.intervention_photos;
create policy photos_insert on public.intervention_photos for insert with check (public.est_valide());
