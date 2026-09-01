# Planning HEC — Application iOS (Capacitor + Codemagic)

L'app iOS emballe le site `web/` dans une vraie app native. Les **données**
restent live (Supabase/Dolibarr) : seule l'**interface** est embarquée.
Le build se fait dans le cloud (Codemagic) — aucun Mac nécessaire.

- **Bundle ID** : `fr.hecmonaco.planning`
- **Nom** : Planning HEC
- **Contenu web** : dossier `web/` (copié dans l'app au build par `cap sync`)

---

## Étapes pour compiler et installer (à faire une fois)

### 1. GitHub — ✅ FAIT
Le projet est déjà poussé sur **https://github.com/Hackheart-tech/planning-hec** (branche `main`).
Pour les mises à jour futures : `git add . && git commit -m "..." && git push`.
> Le `.gitignore` exclut déjà `node_modules`, les Pods, les secrets (.p8/.pem) et les zips.

### 2. App Store Connect : créer la fiche de l'app
1. https://appstoreconnect.apple.com → **Apps** → **+** → Nouvelle app.
2. Plateforme iOS, nom « Planning HEC », langue FR, **Bundle ID `fr.hecmonaco.planning`**
   (à créer d'abord dans le portail Développeur → Identifiers si absent).
3. Une fois créée : **App Information** → note l'**Apple ID** (un nombre, ex `6xxxxxxxxx`).
4. Reporte ce nombre dans `codemagic.yaml` → `APP_STORE_APP_ID` (remplace `PLACEHOLDER_APP_STORE_APP_ID`).

### 3. Codemagic : connecter et configurer
1. https://codemagic.io → **Add application** → connecte le dépôt GitHub.
2. **Settings → Integrations → App Store Connect** → ajoute ta clé API (.p8 + Key ID + Issuer ID).
   Nomme l'intégration **exactement** `Codemagic`.
3. **Environment variables** → groupe `appstore` → variable **`CERTIFICATE_PRIVATE_KEY`** (cochée *Secure*) :
   la clé privée du **certificat de distribution Apple** (PEM). C'est un certificat de **compte**,
   donc tu peux réutiliser **la même que GTALive** (fichier `codemagic_cert_key.pem`).

### 4. Icône de l'app
Le build utilise une icône par défaut. Pour mettre le logo HEC :
- soit remplace les images dans `ios/App/App/Assets.xcassets/AppIcon.appiconset/`,
- soit (plus simple) dépose un `resources/icon.png` (1024×1024) et lance
  `npx @capacitor/assets generate --ios` avant de committer.

### 5. Lancer le build
Dans Codemagic, démarre le workflow **« Planning HEC · iOS TestFlight »**.
À la fin, la build part automatiquement sur **TestFlight** → tu invites ton équipe
(App Store Connect → TestFlight → testeurs internes). Pour publier sur l'App Store
public plus tard : décommente `submit_to_app_store: true` dans `codemagic.yaml`.

---

## À tester sur l'appareil après la 1re build
Ces points marchent sur le web mais sont à vérifier dans l'app native :
- **Connexion email/mot de passe** (le principal — OK attendu).
  Le **lien magique** et **Google** ouvrent une page externe : à valider / adapter
  (deep-link) plus tard si besoin — l'email/mdp suffit pour l'équipe.
- **Appareil photo / photos** sur les fiches (permissions déjà ajoutées à l'Info.plist).
- **Téléchargement du PDF de fiche** (jsPDF) : le WKWebView gère mal les téléchargements
  directs ; si ça coince, on passera par un partage natif (à ajuster après test).

---

## Mettre à jour l'app plus tard
L'app embarque `web/`. Donc après un changement d'interface :
1. mets à jour `web/` (comme pour le site),
2. `git commit` + `git push`,
3. relance le build Codemagic → nouvelle version TestFlight.

> Les changements de **données/logique serveur** (Supabase) sont pris en compte
> immédiatement sans rebuild — seule l'interface embarquée nécessite un nouveau build.
