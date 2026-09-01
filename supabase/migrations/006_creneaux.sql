-- =====================================================================
--  006 - Type de créneau (rdv / blocage), RDV privés, anti-chevauchement
-- =====================================================================

-- Type de créneau : 'rdv' normal ou 'bloc' (congés, indisponibilité)
alter table public.rdv add column if not exists type text not null default 'rdv';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rdv_type_chk') then
    alter table public.rdv add constraint rdv_type_chk check (type in ('rdv', 'bloc'));
  end if;
end $$;

-- RDV privé (masqué aux autres membres)
alter table public.rdv add column if not exists prive boolean not null default false;

-- ------------------------------------------------------------------
-- Anti-chevauchement : une même personne ne peut pas avoir deux
-- créneaux qui se chevauchent (hors annulés). Via trigger pour ne pas
-- bloquer d'éventuels chevauchements déjà présents.
-- ------------------------------------------------------------------
create or replace function public.verifier_chevauchement()
returns trigger language plpgsql as $$
begin
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

drop trigger if exists rdv_chevauchement on public.rdv;
create trigger rdv_chevauchement before insert or update on public.rdv
  for each row execute function public.verifier_chevauchement();
