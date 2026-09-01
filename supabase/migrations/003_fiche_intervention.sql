-- =====================================================================
--  003 - Fiche d'intervention : fichier devis + sécurité du stockage
-- =====================================================================

-- Chemin du fichier devis (PDF) dans le bucket Storage 'interventions'
alter table public.interventions add column if not exists devis_path text;

-- Le stockage des photos/devis n'est accessible qu'aux comptes validés
drop policy if exists interv_photos_read on storage.objects;
create policy interv_photos_read on storage.objects
  for select using (bucket_id = 'interventions' and public.est_valide());

drop policy if exists interv_photos_write on storage.objects;
create policy interv_photos_write on storage.objects
  for insert with check (bucket_id = 'interventions' and public.est_valide());

drop policy if exists interv_photos_delete on storage.objects;
create policy interv_photos_delete on storage.objects
  for delete using (bucket_id = 'interventions' and public.est_valide());
