-- =====================================================================
--  011 - Suivi du temps, rappels, désactivation de membre
-- =====================================================================

-- 4) Suivi du temps sur la fiche (pour la facturation)
alter table public.interventions add column if not exists debut_reel timestamptz;
alter table public.interventions add column if not exists fin_reel timestamptz;

-- 3) Rappel avant RDV : marqueur pour ne l'envoyer qu'une fois
alter table public.rdv add column if not exists rappel_envoye boolean not null default false;

-- 10) Désactivation d'un membre : un compte inactif perd tout accès
create or replace function public.est_valide()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (valide or role = 'admin') and coalesce(actif, true)
       from public.profils where id = auth.uid()),
    false);
$$;

-- Ré-armer le rappel si le RDV est déplacé (+ garder l'anti-chevauchement)
create or replace function public.verifier_chevauchement()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'UPDATE' and NEW.debut is distinct from OLD.debut then
    NEW.rappel_envoye := false;
  end if;
  if NEW.assigne_a is not null and NEW.statut <> 'annule' then
    if exists (
      select 1 from public.rdv r
      where r.assigne_a = NEW.assigne_a
        and r.id <> NEW.id
        and r.statut <> 'annule'
        and tstzrange(r.debut, r.fin, '[)') && tstzrange(NEW.debut, NEW.fin, '[)')
    ) then
      raise exception 'CHEVAUCHEMENT: cette personne a deja un creneau sur cet horaire.';
    end if;
  end if;
  return NEW;
end; $$;
