-- =====================================================================
--  014 - Bons d'intervention : marqueur "traité" (facturé)
-- =====================================================================
alter table public.interventions add column if not exists traite boolean not null default false;
alter table public.interventions add column if not exists traite_le timestamptz;
