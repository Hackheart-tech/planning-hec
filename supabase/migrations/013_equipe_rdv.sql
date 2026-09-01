-- =====================================================================
--  013 - Plusieurs intervenants par RDV (équipes d'installation)
--  assigne_a reste le "responsable" (couleur, droits). Les autres
--  intervenants sont dans rdv_participants. L'anti-chevauchement
--  s'applique à TOUTES les personnes (responsable + participants).
-- =====================================================================

create table if not exists public.rdv_participants (
  rdv_id    uuid not null references public.rdv(id) on delete cascade,
  profil_id uuid not null references public.profils(id) on delete cascade,
  primary key (rdv_id, profil_id)
);
alter table public.rdv_participants enable row level security;

drop policy if exists rp_select on public.rdv_participants;
create policy rp_select on public.rdv_participants
  for select using (public.est_valide());

-- écriture réservée à un gestionnaire ou au responsable du RDV
drop policy if exists rp_write on public.rdv_participants;
create policy rp_write on public.rdv_participants
  for all using (
    public.est_valide() and exists (
      select 1 from public.rdv r
      where r.id = rdv_id and (public.est_gestionnaire() or r.assigne_a = auth.uid())
    )
  ) with check (
    public.est_valide() and exists (
      select 1 from public.rdv r
      where r.id = rdv_id and (public.est_gestionnaire() or r.assigne_a = auth.uid())
    )
  );

-- Une personne est-elle déjà occupée sur ce créneau (comme responsable OU participant) ?
create or replace function public.personne_occupee(p uuid, d timestamptz, f timestamptz, sauf uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.rdv r
    where r.id <> sauf and r.statut <> 'annule'
      and tstzrange(r.debut, r.fin, '[)') && tstzrange(d, f, '[)')
      and (
        r.assigne_a = p
        or exists (select 1 from public.rdv_participants pp where pp.rdv_id = r.id and pp.profil_id = p)
      )
  );
$$;

-- Trigger RDV : le responsable ne doit pas être déjà pris (+ ré-armer le rappel)
create or replace function public.verifier_chevauchement()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'UPDATE' and NEW.debut is distinct from OLD.debut then
    NEW.rappel_envoye := false;
  end if;
  if NEW.assigne_a is not null and NEW.statut <> 'annule'
     and public.personne_occupee(NEW.assigne_a, NEW.debut, NEW.fin, NEW.id) then
    raise exception 'CHEVAUCHEMENT: cette personne a deja un creneau sur cet horaire.';
  end if;
  return NEW;
end; $$;

-- Trigger participant : un intervenant ne doit pas être déjà pris
create or replace function public.verif_participant()
returns trigger language plpgsql as $$
declare d timestamptz; f timestamptz; st text;
begin
  select debut, fin, statut into d, f, st from public.rdv where id = NEW.rdv_id;
  if st is null or st = 'annule' then return NEW; end if;
  if public.personne_occupee(NEW.profil_id, d, f, NEW.rdv_id) then
    raise exception 'CHEVAUCHEMENT: cette personne a deja un creneau sur cet horaire.';
  end if;
  return NEW;
end; $$;

drop trigger if exists rp_chevauchement on public.rdv_participants;
create trigger rp_chevauchement before insert on public.rdv_participants
  for each row execute function public.verif_participant();
