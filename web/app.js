/* =====================================================================
   AgendaBoite - authentification (email/mot de passe, lien magique, Google)
   ===================================================================== */

const $ = (id) => document.getElementById(id);

const ecranConnexion = $("ecran-connexion");
const ecranApp = $("ecran-app");
const ecranAttente = $("ecran-attente");
const message = $("message");

let sb = null;
let modeInscription = false;

/* ---------- 1. Vérification de la config ---------- */
function configOk() {
  const c = window.CONFIG || {};
  return (
    c.SUPABASE_URL &&
    c.SUPABASE_ANON_KEY &&
    !c.SUPABASE_URL.includes("TON-PROJET") &&
    !c.SUPABASE_ANON_KEY.includes("TA_CLE")
  );
}

/* ---------- 2. Messages ---------- */
function afficherMessage(texte, type = "info") {
  message.textContent = texte;
  message.className = "message " + type;
  message.hidden = false;
}
function effacerMessage() {
  message.hidden = true;
}

/* Traduit les erreurs Supabase en français lisible */
function traduireErreur(err) {
  const m = (err && err.message) || "Erreur inconnue";
  const table = {
    "Invalid login credentials": "Email ou mot de passe incorrect.",
    "Email not confirmed": "Il faut d'abord confirmer ton email (vérifie ta boîte de réception).",
    "User already registered": "Ce compte existe déjà. Utilise « Se connecter ».",
    "Password should be at least 6 characters": "Le mot de passe doit faire au moins 6 caractères.",
    "Unable to validate email address: invalid format": "Format d'email invalide.",
    "Signups not allowed for otp": "La création de compte par lien magique est désactivée.",
  };
  for (const cle in table) if (m.includes(cle)) return table[cle];
  if (m.includes("CHEVAUCHEMENT"))
    return "Cette personne a déjà un rendez-vous ou un blocage sur ce créneau.";
  if (m.includes("provider is not enabled"))
    return "Le provider Google n'est pas encore activé dans Supabase (Authentication > Providers).";
  if (m.includes("Failed to fetch"))
    return "Impossible de joindre Supabase. Vérifie l'URL dans config.js et ta connexion.";
  return m;
}

/* ---------- 3. Bascule connexion / inscription ---------- */
function majMode() {
  $("btn-principal").textContent = modeInscription ? "Créer mon compte" : "Se connecter";
  $("btn-bascule").textContent = modeInscription ? "J'ai déjà un compte" : "Créer un compte";
  $("champ-nom").hidden = !modeInscription;
  $("motdepasse").autocomplete = modeInscription ? "new-password" : "current-password";
  effacerMessage();
}

/* ---------- 4. Actions d'authentification ---------- */
async function soumettre(e) {
  e.preventDefault();
  const email = $("email").value.trim();
  const motdepasse = $("motdepasse").value;
  const nom = $("nom").value.trim();

  if (!email || !motdepasse) {
    afficherMessage("Renseigne ton email et ton mot de passe.", "erreur");
    return;
  }

  const bouton = $("btn-principal");
  bouton.disabled = true;
  bouton.textContent = modeInscription ? "Création…" : "Connexion…";

  try {
    if (modeInscription) {
      const { data, error } = await sb.auth.signUp({
        email,
        password: motdepasse,
        options: { data: { nom: nom || email.split("@")[0] } },
      });
      if (error) throw error;
      if (!data.session) {
        afficherMessage(
          "Compte créé. Ouvre l'email de confirmation qu'on vient de t'envoyer, puis reviens te connecter.",
          "ok"
        );
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: motdepasse });
      if (error) throw error;
    }
  } catch (err) {
    afficherMessage(traduireErreur(err), "erreur");
  } finally {
    bouton.disabled = false;
    majMode();
  }
}

async function lienMagique() {
  const email = $("email").value.trim();
  if (!email) {
    afficherMessage("Saisis d'abord ton email, puis reclique sur le lien.", "erreur");
    $("email").focus();
    return;
  }
  try {
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    });
    if (error) throw error;
    afficherMessage("Lien envoyé. Ouvre ta boîte mail et clique dessus pour te connecter.", "ok");
  } catch (err) {
    afficherMessage(traduireErreur(err), "erreur");
  }
}

async function connexionGoogle() {
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (error) throw error;
  } catch (err) {
    afficherMessage(traduireErreur(err), "erreur");
  }
}

async function deconnexion() {
  await sb.auth.signOut();
}

/* ---------- 5. Profil + équipe ---------- */
/* Le profil est créé par un trigger côté base. Juste après une inscription,
   il peut y avoir un très court décalage : on retente quelques fois. */
async function chargerProfil(utilisateur, essais = 5) {
  const { data, error } = await sb
    .from("profils")
    .select("id, nom, email, couleur, role, valide")
    .eq("id", utilisateur.id)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  if (essais > 0) {
    await new Promise((r) => setTimeout(r, 400));
    return chargerProfil(utilisateur, essais - 1);
  }

  // Filet de sécurité si le trigger n'a pas tourné
  const secours = {
    id: utilisateur.id,
    nom: utilisateur.user_metadata?.nom || utilisateur.email.split("@")[0],
    email: utilisateur.email,
  };
  const { data: cree, error: err2 } = await sb
    .from("profils")
    .insert(secours)
    .select("id, nom, email, couleur, role, valide")
    .single();
  if (err2) throw err2;
  return cree;
}

async function chargerEquipe() {
  const liste = $("liste-equipe");
  const { data, error } = await sb
    .from("profils")
    .select("nom, email, couleur, role, actif")
    .order("nom");

  if (error) {
    liste.innerHTML = '<li class="vide">Lecture impossible : ' + traduireErreur(error) + "</li>";
    return;
  }
  if (!data || !data.length) {
    liste.innerHTML = '<li class="vide">Aucun membre pour l\'instant.</li>';
    return;
  }

  liste.innerHTML = "";
  for (const membre of data) {
    const li = document.createElement("li");

    const pastille = document.createElement("span");
    pastille.className = "pastille";
    pastille.style.background = membre.couleur || "#3b82f6";

    const nom = document.createElement("b");
    nom.textContent = membre.nom;

    const role = document.createElement("small");
    role.textContent = membre.role;

    li.append(pastille, nom, role);
    liste.appendChild(li);
  }
}

/* ---------- 6. Affichage ---------- */
function montrerConnexion() {
  ecranApp.hidden = true;
  ecranAttente.hidden = true;
  ecranConnexion.hidden = false;
}

let agendaLance = false;

async function montrerApp(session) {
  ecranConnexion.hidden = true;

  let profil;
  try {
    profil = await chargerProfil(session.user);
  } catch (err) {
    ecranApp.hidden = true;
    ecranConnexion.hidden = false;
    afficherMessage(traduireErreur(err), "erreur");
    return;
  }

  // Compte pas encore validé par un admin → écran d'attente
  if (!profil.valide && profil.role !== "admin") {
    ecranApp.hidden = true;
    ecranAttente.hidden = false;
    $("attente-email").textContent = profil.email || session.user.email;
    return;
  }

  ecranAttente.hidden = true;
  ecranApp.hidden = false;
  $("moi-nom").textContent = profil.nom;
  $("moi-role").textContent = profil.role;
  { const mc = $("moi-couleur"); if (mc) mc.value = profil.couleur || "#94a3b8"; }

  // Démarre l'agenda une seule fois (défini dans agenda.js)
  if (!agendaLance) {
    agendaLance = true;
    window.initAgenda(sb, profil, traduireErreur);
  }
}

/* ---------- 7. Démarrage ---------- */
async function demarrer() {
  if (!configOk()) {
    $("alerte-config").hidden = false;
    montrerConnexion();
    $("form-login").querySelectorAll("input, button").forEach((el) => (el.disabled = true));
    $("btn-google").disabled = true;
    return;
  }

  sb = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_ANON_KEY);

  $("form-login").addEventListener("submit", soumettre);
  $("btn-bascule").addEventListener("click", () => {
    modeInscription = !modeInscription;
    majMode();
  });
  $("btn-lien-magique").addEventListener("click", lienMagique);
  $("btn-google").addEventListener("click", connexionGoogle);
  $("btn-deconnexion").addEventListener("click", deconnexion);
  $("btn-deconnexion-attente").addEventListener("click", deconnexion);

  const { data } = await sb.auth.getSession();
  if (data.session) await montrerApp(data.session);
  else montrerConnexion();

  sb.auth.onAuthStateChange((evenement, session) => {
    if (session) montrerApp(session);
    else montrerConnexion();
  });
}

demarrer();
