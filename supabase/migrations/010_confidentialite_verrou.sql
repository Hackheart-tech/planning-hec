-- =====================================================================
--  010 - Verrouillage réel de la confidentialité des RDV
--  On empêche la lecture DIRECTE des colonnes sensibles de la table rdv
--  (titre, description, client_id, lieu). Tout passe par la vue "agenda"
--  qui masque le détail des créneaux privés / blocages des autres.
-- =====================================================================

-- Vue en mode propriétaire (pas security_invoker) : elle peut lire les
-- colonnes sensibles, applique le masquage, et se limite aux comptes validés.
drop view if exists public.agenda;
create view public.agenda as
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
from public.rdv
where public.est_valide();

grant select on public.agenda to anon, authenticated;

-- Lecture directe de la table rdv : seulement les colonnes non sensibles.
revoke select on public.rdv from anon, authenticated;
grant select (id, debut, fin, assigne_a, type, prive, statut, couleur,
              cree_par, created_at, updated_at, dolibarr_event_id)
  on public.rdv to anon, authenticated;
