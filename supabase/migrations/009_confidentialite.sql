-- =====================================================================
--  009 - Confidentialité côté serveur
--  1) Vue "agenda" : masque le détail des RDV privés / blocages des AUTRES
--     (le titre, la description, le client et le lieu deviennent nuls pour
--      les créneaux qui ne sont pas les miens). Le front lit cette vue.
--  2) Suppression de fichiers réservée à leur auteur (ou gestionnaire).
-- =====================================================================

create or replace view public.agenda with (security_invoker = true) as
select
  id, debut, fin, assigne_a, type, prive, statut, couleur, cree_par,
  case when (prive or type = 'bloc') and assigne_a is distinct from auth.uid()
       then null else titre end as titre,
  case when (prive or type = 'bloc') and assigne_a is distinct from auth.uid()
       then null else description end as description,
  case when (prive or type = 'bloc') and assigne_a is distinct from auth.uid()
       then null else client_id end as client_id,
  case when (prive or type = 'bloc') and assigne_a is distinct from auth.uid()
       then null else lieu end as lieu
from public.rdv;

grant select on public.agenda to anon, authenticated;

-- Stockage : un membre ne peut supprimer que SES fichiers (ou un gestionnaire)
drop policy if exists interv_photos_delete on storage.objects;
create policy interv_photos_delete on storage.objects
  for delete using (
    bucket_id = 'interventions' and public.est_valide()
    and (owner = auth.uid() or public.est_gestionnaire())
  );
