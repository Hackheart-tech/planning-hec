-- =====================================================================
--  004 - Signature du client sur la fiche d'intervention
-- =====================================================================
alter table public.interventions add column if not exists signature_path text;
alter table public.interventions add column if not exists signature_at timestamptz;
