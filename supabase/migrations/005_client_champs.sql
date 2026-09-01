-- =====================================================================
--  005 - Adresse structurée du client (code postal + ville séparés)
-- =====================================================================
alter table public.clients add column if not exists code_postal text;
alter table public.clients add column if not exists ville text;
