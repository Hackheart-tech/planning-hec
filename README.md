# AgendaBoite

Agenda d'équipe + fiches d'intervention client, avec pont Dolibarr 19 (lecture seule).
Stack : Supabase (Postgres + Auth + Storage + RLS) et front web HTML/JS (emballage Capacitor prévu plus tard).

## Étapes de mise en place

1. **Base de données**
   - Ouvre ton projet Supabase > `SQL Editor` > `New query`.
   - Colle le contenu de `supabase/schema.sql` et lance (Run).
   - Puis lance dans l'ordre les fichiers de `supabase/migrations/` (002, ...).
   - Crée ton premier compte (via l'app une fois branchée), puis passe-toi admin :
     `update public.profils set role='admin' where email='ton@email.fr';`

2. **Front web**
   - `web/config.js` : renseigner `SUPABASE_URL` et `SUPABASE_ANON_KEY`
     (Supabase > Settings > API, clé « anon public »).
   - Lancer le serveur local : `node dev-server.js` puis ouvrir http://localhost:5174
     (ne pas ouvrir le fichier directement : Google OAuth exige `http://`).

   **Connexion Google** (optionnel) : Supabase > Authentication > Providers > Google,
   activer et coller les identifiants OAuth de la Google Cloud Console. Dans Google,
   l'URL de redirection autorisée est `https://TON-PROJET.supabase.co/auth/v1/callback`.
   Sans ça, le bouton Google affiche un message d'erreur clair (le reste fonctionne).

3. **Pont Dolibarr** (à venir)
   - Edge Function `dolibarr-sync` : importe clients / devis / interventions / agenda.
   - Secrets côté Supabase (jamais dans le front) :
     `supabase secrets set DOLIBARR_URL=... DOLIBARR_API_KEY=...`

## Rôles

- `admin`   : gère tout, y compris les profils et les rôles.
- `manager` : crée/modifie les RDV et fiches de toute l'équipe.
- `membre`  : voit tous les agendas, maître uniquement du sien.

## Structure

```
supabase/
  schema.sql                     # tables + RLS + storage
  functions/dolibarr-sync/       # import Dolibarr (à venir)
web/
  index.html / app.js / config.js / styles.css   # (à venir)
```
