-- =====================================================================
--  016 - Nouveau type de RDV : "chantier" (impose une fiche d'intervention)
--  Types possibles : 'rdv' (rendez-vous simple), 'chantier' (fiche requise),
--                    'bloc' (indisponibilité / congés).
-- =====================================================================
alter table public.rdv drop constraint if exists rdv_type_chk;
alter table public.rdv add constraint rdv_type_chk
  check (type = any (array['rdv'::text, 'chantier'::text, 'bloc'::text]));
