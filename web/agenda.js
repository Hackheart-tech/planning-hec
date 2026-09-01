/* =====================================================================
   AgendaBoite - agenda d'équipe + dossiers en attente
   Exporte window.initAgenda(sb, profil, traduireErreur)
   ===================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");

  // état
  let sb, moi, traduire;
  let calendar;
  let profilsById = new Map();
  let clientsById = new Map();
  let clientsListe = [];
  let membresActifs = []; // membres validés/actifs (pour l'équipe et l'assignation)
  let participantsParRdv = {}; // rdv_id -> [profil_id] (autres intervenants)
  let ficheParRdv = {}; // rdv_id -> true si la fiche est signée (faite)
  let rdvData = [];
  const selection = new Set(); // ids des membres affichés
  let editionId = null; // id du rdv en cours d'édition (null = création)
  let rdvOuvert = null; // objet rdv actuellement ouvert dans la modale
  let planifDepuisInterv = null; // id d'intervention qu'on est en train de planifier
  let ficheId = null; // id de l'intervention affichée dans la fiche
  let ficheCtx = null; // { client, rdvTitre } pour l'export PDF
  let ficheRetourBons = false; // fiche ouverte depuis la page Bons -> y revenir en fermant
  let coordOriginale = null; // coordonnées client au moment de l'ouverture (pour détecter les modifs)
  let signatureDessine = false; // le client a-t-il tracé une signature ?

  const COULEUR_DEFAUT = "#94a3b8"; // gris = pas encore de couleur attribuée
  const PALETTE = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899",
    "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#d946ef",
    "#eab308", "#22c55e", "#0ea5e9", "#f43f5e",
  ];
  // renvoie la première couleur de la palette non utilisée (sinon une au hasard fixe)
  function couleurLibre() {
    const prises = new Set([...profilsById.values()].map((p) => p.couleur));
    const libre = PALETTE.find((c) => !prises.has(c));
    return libre || PALETTE[profilsById.size % PALETTE.length];
  }
  const URGENCES = {
    urgent: { label: "Urgent", rang: 0, classe: "u-hi" },
    semaine: { label: "Cette semaine", rang: 1, classe: "u-md" },
    normale: { label: "Quand possible", rang: 2, classe: "u-lo" },
  };

  const estGestionnaire = () => moi.role === "admin" || moi.role === "manager";
  const peutModifier = (r) => estGestionnaire() || r.assigne_a === moi.id;
  // Suppression : membre = les siens ; manager = siens + membres (hors blocage) ; admin = tout
  function peutSupprimer(r) {
    if (r.assigne_a === moi.id) return true;
    if (moi.role === "admin") return true;
    if (moi.role === "manager") {
      const p = profilsById.get(r.assigne_a);
      return !!(p && p.role === "membre" && r.type !== "bloc");
    }
    return false;
  }

  /* ---------- dates <-> input datetime-local ---------- */
  function versInput(d) {
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }
  function depuisInput(str) {
    return new Date(str).toISOString();
  }

  /* ---------- chargements ---------- */
  async function chargerProfils() {
    const { data, error } = await sb
      .from("profils")
      .select("id, nom, email, couleur, role, valide, actif")
      .order("nom");
    if (error) throw error;
    profilsById = new Map(data.map((p) => [p.id, p]));

    const valides = data.filter((p) => (p.valide || p.role === "admin") && p.actif !== false);
    if (!selection.size) valides.forEach((p) => selection.add(p.id));
    membresActifs = valides;
    rendreFiltreEquipe(valides);
    remplirSelectAssigne(valides);
    remplirEquipe();

    // badge "comptes à valider" pour l'admin
    const enAttente = data.filter((p) => !p.valide && p.role !== "admin").length;
    const badge = $("equipe-attente-badge");
    badge.textContent = enAttente;
    badge.hidden = enAttente === 0;
  }

  function remplirSelectClient(sel, data) {
    const val = sel.value;
    sel.innerHTML =
      '<option value="">Choisir un client</option>' +
      '<option value="__nouveau__">+ Créer un client…</option>';
    data.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.nom;
      sel.appendChild(o);
    });
    if ([...sel.options].some((o) => o.value === val)) sel.value = val;
  }

  async function chargerClients() {
    const { data, error } = await sb
      .from("clients")
      .select("id, nom, email, telephone, adresse, code_postal, ville, dolibarr_id")
      .order("nom");
    if (error) return; // table peut être vide, pas bloquant
    clientsById = new Map(data.map((c) => [c.id, c]));
    clientsListe = data;
    remplirSelectClient($("r-client"), data);
    remplirSelectClient($("a-client"), data);
  }

  // Filtre la liste des clients par nom et repeuple le select associé
  function rechercherClient(selectId, terme) {
    const t = (terme || "").trim().toLowerCase();
    const data = t ? clientsListe.filter((c) => (c.nom || "").toLowerCase().includes(t)) : clientsListe;
    remplirSelectClient($(selectId), data);
  }

  // Appel de la fonction serveur dolibarr-sync (clé API jamais côté client)
  async function appelDolibarr(payload) {
    const { data, error } = await sb.functions.invoke("dolibarr-sync", { body: payload });
    if (error) {
      let msg = traduire(error);
      try {
        const j = await error.context.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      return { ok: false, error: msg };
    }
    return { ok: true, ...data };
  }

  // Envoi de mail (non bloquant) via la fonction notify-mailer
  function envoyerMail(payload) {
    sb.functions.invoke("notify-mailer", { body: payload }).catch(() => {});
  }

  async function chargerRdv() {
    const { data, error } = await sb
      .from("agenda")
      .select("id, titre, description, debut, fin, assigne_a, client_id, lieu, statut, couleur, type, prive");
    if (error) throw error;
    rdvData = data;
    const { data: parts } = await sb.from("rdv_participants").select("rdv_id, profil_id");
    participantsParRdv = {};
    (parts || []).forEach((p) => {
      (participantsParRdv[p.rdv_id] = participantsParRdv[p.rdv_id] || []).push(p.profil_id);
    });
    // état des fiches (signée = faite) par RDV
    const { data: fiches } = await sb.from("interventions").select("rdv_id, signature_path").not("rdv_id", "is", null);
    ficheParRdv = {};
    (fiches || []).forEach((f) => {
      if (f.signature_path) ficheParRdv[f.rdv_id] = true;
    });
    rendreEvenements();
  }

  async function chargerAttente() {
    const { data, error } = await sb
      .from("interventions")
      .select("id, titre, description, notes, urgence, client_id, cree_par, created_at, origine")
      .is("rdv_id", null);
    const liste = $("liste-attente");
    if (error) {
      liste.innerHTML = '<span class="vide"></span>';
      liste.firstChild.textContent = traduire(error);
      return;
    }
    data.sort((a, b) => {
      const ra = (URGENCES[a.urgence] || URGENCES.normale).rang;
      const rb = (URGENCES[b.urgence] || URGENCES.normale).rang;
      return ra - rb || a.created_at.localeCompare(b.created_at);
    });
    $("attente-compteur").textContent = data.length;
    if (!data.length) {
      liste.innerHTML = '<span class="vide">Aucun dossier en attente.</span>';
      return;
    }
    liste.innerHTML = "";
    data.forEach((it) => {
      const u = URGENCES[it.urgence] || URGENCES.normale;
      const auteur = profilsById.get(it.cree_par);
      const doli = it.origine === "dolibarr_commande";
      const carte = document.createElement("div");
      carte.className = "carte-attente" + (doli ? " carte-devis" : "");
      carte.tabIndex = 0;
      carte.innerHTML =
        '<span class="urgence ' + u.classe + '">' + u.label + "</span>" +
        (doli ? '<span class="badge-devis">✔ Devis validé</span>' : "") +
        "<b></b><small></small><em></em>";
      const client = clientsById.get(it.client_id);
      const adr = client
        ? [client.adresse, [client.code_postal, client.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ")
        : "";
      carte.querySelector("b").textContent = it.titre;
      carte.querySelector("small").textContent = client ? (client.nom + (adr ? " — " + adr : "")) : "";
      carte.querySelector("em").textContent = doli
        ? "commande validée dans Dolibarr"
        : "signalé par " + (auteur ? auteur.nom : "?");
      carte.addEventListener("click", () => planifierIntervention(it));
      if (moi.role === "admin") {
        const suppr = document.createElement("button");
        suppr.type = "button";
        suppr.className = "attente-suppr";
        suppr.textContent = "×";
        suppr.title = "Supprimer ce dossier";
        suppr.addEventListener("click", (e) => {
          e.stopPropagation();
          supprimerAttente(it);
        });
        carte.appendChild(suppr);
      }
      liste.appendChild(carte);
    });
  }

  /* ---------- filtre équipe ---------- */
  function rendreFiltreEquipe(profils) {
    const ul = $("filtre-equipe");
    ul.innerHTML = "";
    profils.forEach((p) => {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selection.has(p.id);
      cb.addEventListener("change", () => {
        cb.checked ? selection.add(p.id) : selection.delete(p.id);
        rendreEvenements();
      });
      const pastille = document.createElement("i");
      pastille.style.background = p.couleur || COULEUR_DEFAUT;
      const nom = document.createElement("span");
      nom.textContent = p.nom + (p.id === moi.id ? " (moi)" : "");
      label.append(cb, pastille, nom);
      li.appendChild(label);
      ul.appendChild(li);
    });
  }

  // Cases à cocher de l'équipe (autres intervenants)
  function remplirEquipe(coches) {
    const box = $("r-equipe");
    if (!box) return;
    const set = new Set(coches || []);
    box.innerHTML = "";
    membresActifs.forEach((p) => {
      const lab = document.createElement("label");
      lab.className = "equipe-opt";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = p.id;
      cb.checked = set.has(p.id);
      const dot = document.createElement("i");
      dot.style.background = p.couleur || COULEUR_DEFAUT;
      const nom = document.createElement("span");
      nom.textContent = p.nom + (p.id === moi.id ? " (moi)" : "");
      lab.append(cb, dot, nom);
      box.appendChild(lab);
    });
  }

  function remplirSelectAssigne(profils) {
    const sel = $("r-assigne");
    sel.innerHTML = "";
    profils.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.nom;
      sel.appendChild(o);
    });
  }

  /* ---------- calendrier ---------- */
  function versEvent(r) {
    const p = profilsById.get(r.assigne_a);
    const estMien = r.assigne_a === moi.id;
    const bloc = r.type === "bloc";
    const blocAutre = bloc && !estMien; // congé/indispo d'un collègue : affiché en fond, non bloquant
    const priveAutre = r.prive && !estMien;
    let couleur = r.couleur || (p && p.couleur) || COULEUR_DEFAUT;
    let titre = r.titre;
    const classes = [];
    if (bloc) {
      couleur = "#9ca3af";
      classes.push("ev-bloc");
      if (!estMien) titre = "Indisponible";
    } else if (priveAutre) {
      titre = "Privé";
      couleur = "#9ca3af";
      classes.push("ev-prive");
    }
    const client = !priveAutre && !bloc ? clientsById.get(r.client_id) : null;
    const team = participantsParRdv[r.id] || [];
    const suffixe = team.length && !priveAutre ? " 👥" + (team.length + 1) : "";
    const prefixe = r.type === "chantier" && !priveAutre ? "🏗️ " : "";
    // pastille fiche : verte si signée (faite), rouge sinon — uniquement pour les chantiers
    if (r.type === "chantier" && !priveAutre) classes.push(ficheParRdv[r.id] ? "fiche-ok" : "fiche-ko");
    return {
      id: r.id,
      title: prefixe + titre + (client ? " · " + client.nom : "") + suffixe,
      start: r.debut,
      end: r.fin,
      backgroundColor: couleur,
      borderColor: couleur,
      display: blocAutre ? "background" : "auto", // congé d'un collègue : simple bande de fond
      editable: peutModifier(r) && !priveAutre && !blocAutre,
      classNames: classes,
      extendedProps: { rdv: r },
    };
  }

  // clic sur un événement : bloque l'ouverture d'un créneau privé/bloc d'un collègue
  function ouvrirDepuisEvent(r) {
    const estMien = r.assigne_a === moi.id;
    if (!estMien && (r.prive || r.type === "bloc")) {
      alert(r.type === "bloc" ? "Créneau bloqué par un collègue (indisponible)." : "Rendez-vous privé d'un collègue.");
      return;
    }
    ouvrirModalRdv(r);
  }

  function rendreEvenements() {
    if (!calendar) return;
    calendar.getEvents().forEach((e) => e.remove());
    rdvData.forEach((r) => {
      const pers = [r.assigne_a, ...(participantsParRdv[r.id] || [])].filter(Boolean);
      if (pers.length && !pers.some((id) => selection.has(id))) return;
      calendar.addEvent(versEvent(r));
    });
  }

  function initCalendrier() {
    const surMobile = window.innerWidth < 760;
    calendar = new FullCalendar.Calendar($("calendrier"), {
      locale: "fr",
      initialView: surMobile ? "timeGridDay" : "timeGridWeek", // vue jour sur téléphone
      headerToolbar: surMobile
        ? { left: "prev,next", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth" }
        : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay" },
      firstDay: 1,
      nowIndicator: true,
      allDaySlot: false,
      businessHours: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" },
      slotMinTime: "07:00:00",
      slotMaxTime: "20:00:00",
      height: surMobile ? "auto" : "100%", // mobile : hauteur naturelle, la page défile
      expandRows: true,
      selectable: true,
      editable: true,
      eventClick: (info) => ouvrirDepuisEvent(info.event.extendedProps.rdv),
      select: (info) => ouvrirModalRdv(null, info.start, info.end),
      eventDrop: (info) => deplacer(info),
      eventResize: (info) => deplacer(info),
    });
    calendar.render();
  }

  async function deplacer(info) {
    const r = info.event.extendedProps.rdv;
    if (!peutModifier(r)) {
      info.revert();
      return;
    }
    const patch = { debut: info.event.start.toISOString(), fin: (info.event.end || info.event.start).toISOString() };
    const { error } = await sb.from("rdv").update(patch).eq("id", r.id);
    if (error) {
      info.revert();
      alert(traduire(error));
    } else {
      Object.assign(r, patch);
    }
  }

  /* ---------- modale RDV ---------- */
  function messageModal(id, texte, type) {
    const el = $(id);
    if (!texte) { el.hidden = true; return; }
    el.textContent = texte;
    el.className = "message " + (type || "erreur");
    el.hidden = false;
  }

  // Affiche et pré-remplit les coordonnées d'un client existant dans le RDV
  function remplirCoordClient(id) {
    const c = clientsById.get(id);
    const bloc = $("bloc-coord-client");
    if (!c) {
      bloc.hidden = true;
      coordOriginale = null;
      return;
    }
    // champ rempli (vient de Dolibarr) => verrouillé ; champ vide => saisissable
    const poser = (inputId, valeur) => {
      const el = $(inputId);
      el.value = valeur || "";
      el.disabled = !!(valeur && String(valeur).trim());
    };
    poser("r-cc-adresse", c.adresse);
    poser("r-cc-cp", c.code_postal);
    poser("r-cc-ville", c.ville);
    poser("r-cc-tel", c.telephone);
    poser("r-cc-email", c.email);
    bloc.hidden = false;
    $("bloc-nouveau-client").hidden = true;
    coordOriginale = {
      id: id,
      adresse: c.adresse || "",
      cp: c.code_postal || "",
      ville: c.ville || "",
      tel: c.telephone || "",
      email: c.email || "",
    };
    // pratique : si le lieu du RDV est vide, on y met l'adresse complète du client
    const adrComplete = [c.adresse, [c.code_postal, c.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    if (!$("r-lieu").value && adrComplete) $("r-lieu").value = adrComplete;
  }

  // Bascule l'affichage selon le type : un blocage n'a pas de client
  function basculerType() {
    const bloc = $("r-type").value === "bloc";
    $("champ-client").hidden = bloc;
    $("champ-equipe").hidden = bloc; // pas d'équipe sur un blocage perso
    $("r-titre-label").textContent = bloc ? "Motif (ex : Congés, indispo)" : "Titre";
    if (bloc) {
      $("bloc-nouveau-client").hidden = true;
      $("bloc-coord-client").hidden = true;
    }
  }

  function ouvrirModalRdv(rdv, debut, fin) {
    editionId = rdv ? rdv.id : null;
    rdvOuvert = rdv || null;
    messageModal("rdv-message", "");
    const lecture = rdv && !peutModifier(rdv);

    $("rdv-titre-modal").textContent = rdv
      ? (lecture ? "Rendez-vous (lecture seule)" : "Modifier le rendez-vous")
      : "Nouveau rendez-vous";

    // valeurs
    $("r-titre").value = rdv ? rdv.titre : "";
    $("r-desc").value = rdv ? rdv.description || "" : "";
    $("r-lieu").value = rdv ? rdv.lieu || "" : "";
    $("r-statut").value = rdv ? rdv.statut : "planifie";
    $("r-type").value = rdv ? rdv.type || "rdv" : "rdv";
    $("r-prive").checked = rdv ? !!rdv.prive : false;
    $("r-client-search").value = "";
    rechercherClient("r-client", "");
    $("r-client").value = rdv && rdv.client_id ? rdv.client_id : "";
    // reset bloc "nouveau client"
    $("bloc-nouveau-client").hidden = true;
    ["r-client-nom", "r-nc-adresse", "r-nc-cp", "r-nc-ville", "r-client-tel", "r-nc-email"].forEach((i) => ($(i).value = ""));
    // coordonnées du client
    $("bloc-coord-client").hidden = true;
    coordOriginale = null;
    if (rdv && rdv.client_id) remplirCoordClient(rdv.client_id);

    const d = rdv ? new Date(rdv.debut) : debut || new Date();
    const f = rdv ? new Date(rdv.fin) : fin || new Date(d.getTime() + 3600000);
    $("r-debut").value = versInput(d);
    $("r-fin").value = versInput(f);

    // assigné : verrouillé sur soi pour un simple membre
    const selA = $("r-assigne");
    selA.value = rdv ? rdv.assigne_a || moi.id : moi.id;
    selA.disabled = !estGestionnaire();
    remplirEquipe(rdv ? participantsParRdv[rdv.id] || [] : []);

    // lecture seule ?
    ["r-titre", "r-desc", "r-lieu", "r-statut", "r-client", "r-debut", "r-fin"].forEach(
      (i) => ($(i).disabled = lecture)
    );
    $("r-enregistrer").hidden = lecture;
    $("r-supprimer").hidden = !rdv || lecture || !peutSupprimer(rdv);
    // Remettre un RDV dans les tâches à faire (retire du calendrier) — pas pour un blocage
    $("r-vers-attente").hidden = !rdv || lecture || rdv.type === "bloc" || !peutSupprimer(rdv);
    $("r-fiche").hidden = !rdv || rdv.type === "bloc"; // pas de fiche pour un blocage

    basculerType();
    ouvrir("modal-rdv");
    if (!lecture) setTimeout(() => $("r-titre").focus(), 50);
  }

  async function enregistrerRdv() {
    let titre = $("r-titre").value.trim();
    const type = $("r-type").value;
    const prive = $("r-prive").checked;
    if (!titre) {
      if (type === "bloc") titre = "Indisponible";
      else return messageModal("rdv-message", "Il faut un titre.");
    }
    const debut = $("r-debut").value;
    const fin = $("r-fin").value;
    if (!debut || !fin) return messageModal("rdv-message", "Renseigne le début et la fin.");
    if (new Date(fin) < new Date(debut)) return messageModal("rdv-message", "La fin est avant le début.");

    // Un chantier ne peut passer « Terminé » que si sa fiche d'intervention est faite (signée)
    if ($("r-statut").value === "termine" && type === "chantier") {
      let signee = false;
      if (editionId) {
        const q = await sb.from("interventions").select("signature_path").eq("rdv_id", editionId).maybeSingle();
        signee = !!(q.data && q.data.signature_path);
      }
      if (!signee) {
        return messageModal("rdv-message", "Impossible de terminer : la fiche d'intervention n'est pas encore faite (elle doit être signée).");
      }
    }

    // Client : obligatoire pour un RDV/chantier non privé ; optionnel si privé ; jamais pour un blocage
    let client_id = null;
    if (type === "rdv" || type === "chantier") {
      const val = $("r-client").value;
      if (!prive && val === "") return messageModal("rdv-message", "Choisis un client, ou crée-en un.");
      if (val === "__nouveau__") {
        const nom = $("r-client-nom").value.trim();
        if (!nom) return messageModal("rdv-message", "Donne le nom du nouveau client.");
        messageModal("rdv-message", "Création du client dans Dolibarr…", "info");
        const c = await appelDolibarr({
          action: "create",
          nom,
          adresse: $("r-nc-adresse").value.trim(),
          code_postal: $("r-nc-cp").value.trim(),
          ville: $("r-nc-ville").value.trim(),
          tel: $("r-client-tel").value.trim(),
          email: $("r-nc-email").value.trim(),
        });
        if (!c.ok) return messageModal("rdv-message", c.error);
        client_id = c.id;
      } else if (val) {
        client_id = val;
        // coordonnées corrigées pour un client existant ? on pousse vers Dolibarr
        if (coordOriginale && coordOriginale.id === client_id) {
          const maj = {};
          const adr = $("r-cc-adresse").value.trim();
          const cp = $("r-cc-cp").value.trim();
          const vil = $("r-cc-ville").value.trim();
          const tel = $("r-cc-tel").value.trim();
          const eml = $("r-cc-email").value.trim();
          if (adr !== coordOriginale.adresse) maj.adresse = adr;
          if (cp !== coordOriginale.cp) maj.code_postal = cp;
          if (vil !== coordOriginale.ville) maj.ville = vil;
          if (tel !== coordOriginale.tel) maj.tel = tel;
          if (eml !== coordOriginale.email) maj.email = eml;
          if (Object.keys(maj).length) {
            messageModal("rdv-message", "Mise à jour des coordonnées…", "info");
            const u = await appelDolibarr({ action: "update", client_id: client_id, ...maj });
            if (!u.ok) return messageModal("rdv-message", u.error);
          }
        }
      }
    }

    const payload = {
      titre,
      description: $("r-desc").value.trim() || null,
      lieu: $("r-lieu").value.trim() || null,
      statut: $("r-statut").value,
      type: type,
      prive: prive,
      client_id: client_id,
      assigne_a: estGestionnaire() ? $("r-assigne").value : moi.id,
      debut: depuisInput(debut),
      fin: depuisInput(fin),
    };

    let error, nouvelId;
    if (editionId) {
      ({ error } = await sb.from("rdv").update(payload).eq("id", editionId));
    } else {
      payload.cree_par = moi.id;
      const res = await sb.from("rdv").insert(payload).select("id").single();
      error = res.error;
      nouvelId = res.data && res.data.id;
    }
    if (error) return messageModal("rdv-message", traduire(error));

    // si on planifiait un dossier en attente, on le rattache
    if (planifDepuisInterv && nouvelId) {
      await sb.from("interventions").update({ rdv_id: nouvelId, statut: "en_cours" }).eq("id", planifDepuisInterv);
      planifDepuisInterv = null;
      chargerAttente();
    }
    // Équipe (autres intervenants) : on resynchronise rdv_participants
    const rdvId = editionId || nouvelId;
    let errEquipe = null;
    let ajoutes = [];
    let coches = [];
    if (rdvId) {
      const avant = new Set(participantsParRdv[rdvId] || []);
      await sb.from("rdv_participants").delete().eq("rdv_id", rdvId);
      if (payload.type !== "bloc") {
        coches = [...$("r-equipe").querySelectorAll("input:checked")]
          .map((cb) => cb.value)
          .filter((id) => id !== payload.assigne_a);
        if (coches.length) {
          const { error: ep } = await sb.from("rdv_participants").insert(coches.map((id) => ({ rdv_id: rdvId, profil_id: id })));
          if (ep) errEquipe = ep;
        }
        ajoutes = coches.filter((id) => !avant.has(id));
      }
    }

    if (!editionId && nouvelId) {
      // création : on prévient l'équipe SAUF soi-même (le créateur)
      const aPrevenir = [...new Set([payload.assigne_a, ...coches].filter(Boolean))].filter((id) => id !== moi.id);
      if (aPrevenir.length) envoyerMail({ type: "rdv", id: nouvelId, only: aPrevenir });
    } else if (editionId && !errEquipe) {
      // modification : on prévient uniquement les personnes ajoutées (sauf soi-même)
      const aPrevenir = ajoutes.filter((id) => id !== moi.id);
      if (aPrevenir.length) envoyerMail({ type: "rdv", id: rdvId, only: aPrevenir });
    }
    await chargerClients();
    await chargerRdv();
    if (errEquipe) return messageModal("rdv-message", "RDV enregistré, mais un intervenant est déjà pris sur ce créneau (il n'a pas été ajouté).");
    fermer("modal-rdv");
  }

  async function supprimerRdv() {
    if (!editionId) return;
    if (!confirm("Supprimer ce rendez-vous ?")) return;
    const { error } = await sb.from("rdv").delete().eq("id", editionId);
    if (error) return messageModal("rdv-message", traduire(error));
    fermer("modal-rdv");
    await chargerRdv();
  }

  /* ---------- dossiers en attente ---------- */
  function planifierIntervention(it) {
    planifDepuisInterv = it.id;
    ouvrirModalRdv(null);
    $("r-titre").value = it.titre;
    $("r-desc").value = it.notes || "";
    if (it.client_id) $("r-client").value = it.client_id;
    $("rdv-titre-modal").textContent = "Planifier : " + it.titre;
  }

  // RDV -> tâche à faire : retire du calendrier et le renvoie dans la barre "Dossiers en attente"
  async function rdvVersAttente() {
    const r = rdvOuvert;
    if (!r || r.type === "bloc") return;
    if (!confirm("Retirer ce rendez-vous du calendrier et le remettre dans les tâches à faire ?")) return;

    // Réutiliser la fiche/intervention déjà liée si elle existe (garde photos, devis, notes),
    // sinon en créer une nouvelle à partir du RDV.
    const { data: ex } = await sb.from("interventions").select("id, titre, urgence").eq("rdv_id", r.id).maybeSingle();
    if (ex) {
      const patch = { rdv_id: null };
      if (!ex.urgence) patch.urgence = "normale";
      if (!ex.titre) patch.titre = r.titre;
      const { error } = await sb.from("interventions").update(patch).eq("id", ex.id);
      if (error) return messageModal("rdv-message", traduire(error));
    } else {
      const { error } = await sb.from("interventions").insert({
        titre: r.titre,
        client_id: r.client_id || null,
        notes: r.description || null,
        urgence: "normale",
        statut: "devis",
        cree_par: moi.id,
      });
      if (error) return messageModal("rdv-message", traduire(error));
    }

    // Retirer le RDV du calendrier (l'intervention est déjà détachée -> pas de cascade)
    const { error: eDel } = await sb.from("rdv").delete().eq("id", r.id);
    if (eDel) return messageModal("rdv-message", traduire(eDel));

    fermer("modal-rdv");
    await chargerRdv();
    await chargerAttente();
  }

  async function supprimerAttente(it) {
    if (!confirm('Supprimer le dossier "' + it.titre + '" ?')) return;
    const { error } = await sb.from("interventions").delete().eq("id", it.id);
    if (error) return alert(traduire(error));
    await chargerAttente();
  }

  function reinitSignalement() {
    $("a-titre").value = "";
    $("a-note").value = "";
    $("a-urgence").value = "normale";
    $("a-client-search").value = "";
    rechercherClient("a-client", "");
    $("a-client").value = "";
    ["a-client-nom", "a-nc-adresse", "a-nc-cp", "a-nc-ville", "a-client-tel", "a-nc-email"].forEach((i) => ($(i).value = ""));
    $("bloc-nouveau-client-attente").hidden = true;
  }

  async function enregistrerSignalement() {
    const titre = $("a-titre").value.trim();
    if (!titre) return messageModal("attente-message", "Dis au moins de quoi il s'agit.");

    // Client OBLIGATOIRE (choisi ou créé à la volée)
    let client_id = $("a-client").value;
    if (client_id === "") return messageModal("attente-message", "Choisis un client, ou crée-en un.");
    if (client_id === "__nouveau__") {
      const nom = $("a-client-nom").value.trim();
      if (!nom) return messageModal("attente-message", "Donne le nom du nouveau client.");
      messageModal("attente-message", "Création du client dans Dolibarr…", "info");
      const c = await appelDolibarr({
        action: "create",
        nom,
        adresse: $("a-nc-adresse").value.trim(),
        code_postal: $("a-nc-cp").value.trim(),
        ville: $("a-nc-ville").value.trim(),
        tel: $("a-client-tel").value.trim(),
        email: $("a-nc-email").value.trim(),
      });
      if (!c.ok) return messageModal("attente-message", c.error);
      client_id = c.id;
    }

    const payload = {
      titre,
      client_id: client_id,
      notes: $("a-note").value.trim() || null,
      urgence: $("a-urgence").value,
      statut: "devis",
      cree_par: moi.id,
    };
    const { data, error } = await sb.from("interventions").insert(payload).select("id").single();
    if (error) return messageModal("attente-message", traduire(error));
    // prévenir les admins (sauf soi-même) qu'un dossier est à planifier
    if (data && data.id) envoyerMail({ type: "dossier", id: data.id });
    fermer("modal-attente");
    reinitSignalement();
    await chargerClients();
    await chargerAttente();
  }

  /* ---------- fiche d'intervention ---------- */
  function nettoyerNom(nom) {
    return (nom || "fichier").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
  }

  async function urlSignee(path) {
    const { data } = await sb.storage.from("interventions").createSignedUrl(path, 3600);
    return data ? data.signedUrl : null;
  }

  const FICHE_SEL = "id, titre, montant_devis, statut, notes, devis_path, signature_path, signature_at, client_id, debut_reel, fin_reel, rdv_id";

  // Remplit et ouvre la fiche à partir d'une intervention (it) + infos RDV éventuelles
  async function afficherFiche(it, rdvInfo) {
    ficheId = it.id;
    const client = clientsById.get(it.client_id);
    const titre = (rdvInfo && rdvInfo.titre) || it.titre;
    ficheCtx = { client: client || null, rdvTitre: titre };
    $("fiche-titre").textContent = "Fiche : " + titre;
    $("fiche-client").textContent = client ? client.nom : "Non renseigné";
    $("fiche-rdv").textContent = rdvInfo && rdvInfo.debut
      ? titre + " · " + new Date(rdvInfo.debut).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
      : "Dossier (non planifié)";
    $("fiche-statut").value = it.statut || "devis";
    $("fiche-notes").value = it.notes || "";
    $("fiche-arrivee").value = it.debut_reel ? versInput(new Date(it.debut_reel)) : "";
    $("fiche-depart").value = it.fin_reel ? versInput(new Date(it.fin_reel)) : "";
    majDuree();
    $("fiche-devis-picker").hidden = true;
    ouvrir("modal-fiche");
    await rendreDevis(it.devis_path);
    await rendrePhotos();
    await rendreSignature(it.signature_path, it.signature_at);
  }

  async function ouvrirFiche(rdv) {
    messageModal("fiche-message", "");
    let { data: it, error } = await sb.from("interventions").select(FICHE_SEL).eq("rdv_id", rdv.id).maybeSingle();
    if (error) return alert(traduire(error));
    if (!it) {
      const ins = await sb
        .from("interventions")
        .insert({ rdv_id: rdv.id, client_id: rdv.client_id, titre: rdv.titre, statut: "en_cours", cree_par: moi.id })
        .select(FICHE_SEL)
        .single();
      if (ins.error) return alert(traduire(ins.error));
      it = ins.data;
    }
    await afficherFiche(it, { titre: rdv.titre, debut: rdv.debut });
  }

  // Ouvre la fiche directement depuis un bon (id d'intervention)
  async function ouvrirFicheParId(id) {
    messageModal("fiche-message", "");
    const { data: it, error } = await sb.from("interventions").select(FICHE_SEL).eq("id", id).maybeSingle();
    if (error || !it) return alert("Bon introuvable.");
    let rdvInfo = null;
    if (it.rdv_id) {
      const r = await sb.from("agenda").select("titre,debut").eq("id", it.rdv_id).maybeSingle();
      if (r.data) rdvInfo = { titre: r.data.titre || it.titre, debut: r.data.debut };
    }
    await afficherFiche(it, rdvInfo);
  }

  async function enregistrerFiche() {
    if (!ficheId) return;
    const patch = {
      statut: $("fiche-statut").value,
      notes: $("fiche-notes").value.trim() || null,
      debut_reel: $("fiche-arrivee").value ? depuisInput($("fiche-arrivee").value) : null,
      fin_reel: $("fiche-depart").value ? depuisInput($("fiche-depart").value) : null,
    };

    // signature tracée par le client ? on l'enregistre
    if (signatureDessine && !$("fiche-signature").hidden) {
      const cv = $("fiche-signature");
      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      if (blob) {
        const path = ficheId + "/signature.png";
        const up = await sb.storage.from("interventions").upload(path, blob, { upsert: true, contentType: "image/png" });
        if (!up.error) {
          patch.signature_path = path;
          patch.signature_at = new Date().toISOString();
        }
      }
    }

    const { error } = await sb.from("interventions").update(patch).eq("id", ficheId);
    if (error) return messageModal("fiche-message", traduire(error));
    // fiche enregistrée -> transmise à l'adresse dédiée
    envoyerMail({ type: "fiche", id: ficheId });
    fermer("modal-fiche");
    await chargerAttente();
    await chargerRdv(); // met à jour la pastille (rouge/verte) sur l'agenda
  }

  async function rendreDevis(path) {
    const zone = $("fiche-devis");
    zone.innerHTML = "";
    if (!path) {
      zone.textContent = "Aucun devis joint.";
      return;
    }
    const url = await urlSignee(path);
    const a = document.createElement("a");
    a.href = url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "lien-fichier";
    a.textContent = "📄 Voir le devis";
    const suppr = document.createElement("button");
    suppr.type = "button";
    suppr.className = "mini-lien danger";
    suppr.textContent = "retirer";
    suppr.addEventListener("click", () => supprimerDevis(path));
    zone.append(a, suppr);
  }

  async function ajouterDevis(file) {
    if (!file || !ficheId) return;
    messageModal("fiche-message", "Envoi du devis…", "info");
    const path = ficheId + "/devis/" + Date.now() + "_" + nettoyerNom(file.name);
    const up = await sb.storage.from("interventions").upload(path, file, { upsert: true });
    if (up.error) return messageModal("fiche-message", traduire(up.error));
    const { error } = await sb.from("interventions").update({ devis_path: path }).eq("id", ficheId);
    if (error) return messageModal("fiche-message", traduire(error));
    messageModal("fiche-message", "");
    await rendreDevis(path);
  }

  async function supprimerDevis(path) {
    await sb.storage.from("interventions").remove([path]);
    await sb.from("interventions").update({ devis_path: null }).eq("id", ficheId);
    await rendreDevis(null);
  }

  async function rendrePhotos() {
    const grille = $("fiche-photos");
    const { data, error } = await sb
      .from("intervention_photos")
      .select("id, storage_path")
      .eq("intervention_id", ficheId)
      .order("created_at", { ascending: false });
    if (error) {
      grille.innerHTML = '<span class="vide"></span>';
      grille.firstChild.textContent = traduire(error);
      return;
    }
    if (!data.length) {
      grille.innerHTML = '<span class="vide">Aucune photo.</span>';
      return;
    }
    grille.innerHTML = "";
    for (const ph of data) {
      const url = await urlSignee(ph.storage_path);
      const caseP = document.createElement("div");
      caseP.className = "photo-case";
      const img = document.createElement("img");
      img.src = url || "";
      img.loading = "lazy";
      img.addEventListener("click", () => url && window.open(url, "_blank"));
      const suppr = document.createElement("button");
      suppr.type = "button";
      suppr.className = "photo-suppr";
      suppr.textContent = "×";
      suppr.title = "Supprimer";
      suppr.addEventListener("click", () => supprimerPhoto(ph.id, ph.storage_path));
      caseP.append(img, suppr);
      grille.appendChild(caseP);
    }
  }

  async function ajouterPhotos(files) {
    if (!files || !files.length || !ficheId) return;
    messageModal("fiche-message", "Envoi des photos…", "info");
    for (const file of files) {
      const path = ficheId + "/photos/" + Date.now() + "_" + nettoyerNom(file.name);
      const up = await sb.storage.from("interventions").upload(path, file);
      if (up.error) {
        messageModal("fiche-message", traduire(up.error));
        continue;
      }
      await sb.from("intervention_photos").insert({ intervention_id: ficheId, storage_path: path, uploaded_by: moi.id });
    }
    messageModal("fiche-message", "");
    await rendrePhotos();
  }

  async function supprimerPhoto(id, path) {
    if (!confirm("Supprimer cette photo ?")) return;
    await sb.storage.from("interventions").remove([path]);
    await sb.from("intervention_photos").delete().eq("id", id);
    await rendrePhotos();
  }

  /* ---------- devis Dolibarr sur la fiche ---------- */
  async function ouvrirDevisDolibarr() {
    const client = ficheCtx && ficheCtx.client;
    if (!client) return messageModal("fiche-message", "Ce dossier n'a pas de client rattaché.");
    messageModal("fiche-message", "Chargement des devis Dolibarr…", "info");
    const r = await appelDolibarr({ action: "devis_client", client_id: client.id });
    if (!r.ok) return messageModal("fiche-message", r.error);
    const sel = $("fiche-devis-select");
    sel.innerHTML = "";
    if (!r.devis || !r.devis.length) {
      return messageModal("fiche-message", "Aucun devis pour ce client dans Dolibarr.");
    }
    messageModal("fiche-message", "");
    r.devis.forEach((d) => {
      const o = document.createElement("option");
      o.value = d.id;
      const date = d.date ? new Date(d.date).toLocaleDateString("fr-FR") : "";
      o.textContent = [d.ref, date, d.aPdf ? "PDF" : ""].filter(Boolean).join(" · ");
      sel.appendChild(o);
    });
    $("fiche-devis-picker").hidden = false;
  }

  async function lierDevisDolibarr() {
    const proposalId = $("fiche-devis-select").value;
    if (!proposalId || !ficheId) return;
    messageModal("fiche-message", "Liaison du devis…", "info");
    const r = await appelDolibarr({ action: "devis_lier", intervention_id: ficheId, proposal_id: proposalId });
    if (!r.ok) return messageModal("fiche-message", r.error);
    $("fiche-devis-picker").hidden = true;
    await rendreDevis(r.devis_path);
    messageModal("fiche-message", r.devis_path ? "Devis lié, PDF récupéré." : "Devis lié (pas de PDF dans Dolibarr).", "ok");
  }

  /* ---------- export PDF de la fiche ---------- */
  async function urlVersDataURL(url) {
    try {
      const r = await fetch(url);
      const b = await r.blob();
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(b);
      });
    } catch (_) {
      return null;
    }
  }
  function formatImage(dataU) {
    const m = /^data:image\/(\w+);/.exec(dataU || "");
    const f = m ? m[1].toUpperCase() : "PNG";
    return f === "JPG" ? "JPEG" : f;
  }

  async function genererPdfFiche() {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) return alert("Librairie PDF non disponible.");
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const M = 14;
    let y = 18;

    // logo en haut à droite (si image/logo.jpg est présent)
    try {
      const dataU = await urlVersDataURL("image/logo.jpg");
      if (dataU) {
        const img = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = dataU;
        });
        const w = 32;
        const h = w * (img.naturalHeight / img.naturalWidth || 1);
        doc.addImage(dataU, formatImage(dataU), 196 - w, 8, w, h);
      }
    } catch (_) {}

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("Fiche d'intervention", M, y);
    y += 7;
    doc.setDrawColor(200);
    doc.line(M, y, 196, y);
    y += 9;

    doc.setFontSize(11);
    const c = ficheCtx && ficheCtx.client;
    const adr = c ? [c.adresse, [c.code_postal, c.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
    const lignes = [
      ["Client", (c && c.nom) || $("fiche-client").textContent],
      ["Adresse", adr || "Non renseigne"],
      ["Telephone", (c && c.telephone) || "Non renseigne"],
      ["Email", (c && c.email) || "Non renseigne"],
      ["Rendez-vous", $("fiche-rdv").textContent],
      ["Statut", $("fiche-statut").options[$("fiche-statut").selectedIndex].text],
    ];
    lignes.forEach(([k, v]) => {
      doc.setFont("helvetica", "bold");
      doc.text(k + " :", M, y);
      doc.setFont("helvetica", "normal");
      doc.text(doc.splitTextToSize(String(v || ""), 150), M + 40, y);
      y += 7;
    });

    y += 2;
    doc.setFont("helvetica", "bold");
    doc.text("Notes :", M, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    const notes = doc.splitTextToSize($("fiche-notes").value || "-", 182);
    doc.text(notes, M, y);
    y += notes.length * 5 + 4;

    // signature
    let sigData = null;
    if (!$("fiche-signature").hidden && signatureDessine) sigData = $("fiche-signature").toDataURL("image/png");
    else if (!$("fiche-signature-img").hidden && $("fiche-signature-img").src) sigData = await urlVersDataURL($("fiche-signature-img").src);
    if (sigData) {
      if (y > 235) { doc.addPage(); y = 18; }
      doc.setFont("helvetica", "bold");
      doc.text("Signature du client :", M, y);
      y += 4;
      try { doc.addImage(sigData, "PNG", M, y, 60, 25); } catch (_) {}
      y += 30;
    }

    // photos
    const imgs = [...document.querySelectorAll("#fiche-photos img")];
    if (imgs.length) {
      if (y > 235) { doc.addPage(); y = 18; }
      doc.setFont("helvetica", "bold");
      doc.text("Photos :", M, y);
      y += 5;
      let x = M;
      for (const im of imgs.slice(0, 8)) {
        const dataU = await urlVersDataURL(im.src);
        if (!dataU) continue;
        if (y > 250) { doc.addPage(); y = 18; x = M; }
        try { doc.addImage(dataU, formatImage(dataU), x, y, 40, 40); } catch (_) {}
        x += 44;
        if (x > 150) { x = M; y += 44; }
      }
    }

    const nom = (((c && c.nom) || "fiche")).replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
    doc.save("fiche-" + nom + ".pdf");
  }

  /* ---------- signature ---------- */
  function initSignature() {
    const cv = $("fiche-signature");
    const ctx = cv.getContext("2d");
    let dessine = false;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
    };
    cv.addEventListener("pointerdown", (e) => {
      dessine = true;
      signatureDessine = true;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    cv.addEventListener("pointermove", (e) => {
      if (!dessine) return;
      const p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      e.preventDefault();
    });
    const fin = () => { dessine = false; };
    cv.addEventListener("pointerup", fin);
    cv.addEventListener("pointerleave", fin);
    cv.addEventListener("pointercancel", fin);
  }

  function preparerCanvasSignature() {
    const cv = $("fiche-signature");
    cv.width = cv.clientWidth || 300;
    cv.height = 150;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    signatureDessine = false;
  }

  async function rendreSignature(path, at) {
    const cv = $("fiche-signature");
    const img = $("fiche-signature-img");
    const info = $("fiche-signature-info");
    if (path) {
      const url = await urlSignee(path);
      img.src = url || "";
      img.hidden = false;
      cv.hidden = true;
      $("fiche-sig-effacer").hidden = true;
      $("fiche-sig-refaire").hidden = false;
      info.textContent = at
        ? "Signé le " + new Date(at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
        : "Signé";
    } else {
      img.hidden = true;
      cv.hidden = false;
      $("fiche-sig-effacer").hidden = false;
      $("fiche-sig-refaire").hidden = true;
      info.textContent = "Fais signer le client dans le cadre.";
      preparerCanvasSignature();
    }
  }

  /* ---------- vue clients (recherche + historique) ---------- */
  function ouvrirClients() {
    $("clients-vue-detail").hidden = true;
    $("clients-vue-liste").hidden = false;
    $("clients-recherche").value = "";
    rendreResultatsClients("");
    ouvrir("modal-clients");
    setTimeout(() => $("clients-recherche").focus(), 50);
  }

  function rendreResultatsClients(terme) {
    const t = (terme || "").trim().toLowerCase();
    const box = $("clients-resultats");
    box.innerHTML = "";
    if (!clientsListe.length) {
      box.innerHTML = '<div class="vide">Aucun client. Clique sur « ⟳ Dolibarr » pour importer.</div>';
      return;
    }
    const filtres = t ? clientsListe.filter((c) => (c.nom || "").toLowerCase().includes(t)) : clientsListe;
    const data = filtres.slice(0, 100);
    if (!data.length) {
      box.innerHTML = '<div class="vide">Aucun client trouvé.</div>';
      return;
    }
    data.forEach((c) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "client-row";
      row.innerHTML = "<b></b><small></small>";
      row.querySelector("b").textContent = c.nom;
      row.querySelector("small").textContent = [c.code_postal, c.ville].filter(Boolean).join(" ") || c.telephone || "";
      row.addEventListener("click", () => afficherDetailClient(c.id));
      box.appendChild(row);
    });
    if (!t && filtres.length > data.length) {
      const info = document.createElement("div");
      info.className = "vide";
      info.textContent = "Affine ta recherche pour voir les autres clients.";
      box.appendChild(info);
    }
  }

  async function afficherDetailClient(id) {
    const c = clientsById.get(id);
    if (!c) return;
    $("clients-vue-liste").hidden = true;
    $("clients-vue-detail").hidden = false;
    $("cd-nom").textContent = c.nom;
    $("cd-adresse").textContent =
      [c.adresse, [c.code_postal, c.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "Non renseigné";
    $("cd-tel").textContent = c.telephone || "Non renseigné";
    $("cd-email").textContent = c.email || "Non renseigné";
    $("cd-rdvs").innerHTML = '<div class="vide">Chargement…</div>';
    $("cd-interventions").innerHTML = '<div class="vide">Chargement…</div>';

    const [rdvs, intervs] = await Promise.all([
      sb.from("agenda").select("titre,debut,statut").eq("client_id", id).order("debut", { ascending: false }),
      sb.from("interventions").select("titre,montant_devis,statut").eq("client_id", id).order("created_at", { ascending: false }),
    ]);

    const rb = $("cd-rdvs");
    rb.innerHTML = "";
    if (rdvs.error || !rdvs.data.length) rb.innerHTML = '<div class="vide">Aucun rendez-vous.</div>';
    else
      rdvs.data.forEach((r) => {
        const d = document.createElement("div");
        d.className = "cd-item";
        d.innerHTML = "<b></b><small></small>";
        d.querySelector("b").textContent = r.titre;
        d.querySelector("small").textContent = new Date(r.debut).toLocaleDateString("fr-FR") + " · " + r.statut;
        rb.appendChild(d);
      });

    const ib = $("cd-interventions");
    ib.innerHTML = "";
    if (intervs.error || !intervs.data.length) ib.innerHTML = '<div class="vide">Aucune intervention.</div>';
    else
      intervs.data.forEach((it) => {
        const d = document.createElement("div");
        d.className = "cd-item";
        const m = it.montant_devis != null ? Number(it.montant_devis).toFixed(2) + " €" : "";
        d.innerHTML = "<b></b><small></small>";
        d.querySelector("b").textContent = it.titre;
        d.querySelector("small").textContent = [it.statut, m].filter(Boolean).join(" · ");
        ib.appendChild(d);
      });
  }

  /* ---------- navigation Maps ---------- */
  function ouvrirMapsVers(adresse) {
    const dest = (adresse || "").trim();
    if (!dest) return alert("Aucune adresse pour ce rendez-vous.");
    window.open("https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(dest), "_blank");
  }
  function ouvrirMapsRdv() {
    const lieu = $("r-lieu").value.trim();
    let dest = lieu;
    if (!dest) {
      const a = $("r-cc-adresse").value.trim();
      const cpv = [$("r-cc-cp").value.trim(), $("r-cc-ville").value.trim()].filter(Boolean).join(" ");
      dest = [a, cpv].filter(Boolean).join(", ");
    }
    ouvrirMapsVers(dest);
  }

  /* ---------- durée (suivi du temps) ---------- */
  function majDuree() {
    const a = $("fiche-arrivee").value;
    const d = $("fiche-depart").value;
    if (a && d) {
      const ms = new Date(d) - new Date(a);
      if (ms > 0) {
        const min = Math.round(ms / 60000);
        const h = Math.floor(min / 60);
        const m = min % 60;
        $("fiche-duree").textContent = "Durée : " + (h ? h + " h " : "") + m + " min";
        return;
      }
    }
    $("fiche-duree").textContent = "";
  }

  /* ---------- Ma journée ---------- */
  let journeeDate = null;
  function ouvrirJournee() {
    journeeDate = new Date();
    journeeDate.setHours(0, 0, 0, 0);
    rendreJournee();
    ouvrir("modal-journee");
  }
  function bougerJournee(n) {
    journeeDate.setDate(journeeDate.getDate() + n);
    rendreJournee();
  }
  async function rendreJournee() {
    const d0 = new Date(journeeDate);
    const d1 = new Date(journeeDate);
    d1.setDate(d1.getDate() + 1);
    $("journee-date").textContent = journeeDate.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    const box = $("journee-liste");
    box.innerHTML = '<div class="vide">Chargement…</div>';
    const jour = await sb
      .from("agenda")
      .select("id, titre, description, debut, fin, client_id, lieu, type, prive, assigne_a, statut, couleur")
      .gte("debut", d0.toISOString())
      .lt("debut", d1.toISOString())
      .order("debut");
    if (jour.error) {
      box.innerHTML = '<div class="vide"></div>';
      box.firstChild.textContent = traduire(jour.error);
      return;
    }
    // RDV où je suis dans l'équipe ce jour-là
    const ids = jour.data.map((r) => r.id);
    let monEquipe = new Set();
    if (ids.length) {
      const { data: parts } = await sb.from("rdv_participants").select("rdv_id, profil_id").in("rdv_id", ids);
      (parts || []).forEach((p) => {
        if (p.profil_id === moi.id) monEquipe.add(p.rdv_id);
      });
    }
    const data = jour.data.filter((r) => r.assigne_a === moi.id || monEquipe.has(r.id));
    if (!data.length) {
      box.innerHTML = '<div class="vide">Rien de prévu ce jour.</div>';
      return;
    }
    box.innerHTML = "";
    data.forEach((r) => {
      const client = clientsById.get(r.client_id);
      const item = document.createElement("div");
      item.className = "journee-item";
      const h = new Date(r.debut).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      const hf = new Date(r.fin).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      item.innerHTML = '<div class="j-h"></div><div class="j-corps"><b></b><small></small></div>';
      item.querySelector(".j-h").textContent = h + " → " + hf;
      item.querySelector("b").textContent = r.type === "bloc" ? r.titre || "Indisponible" : r.titre;
      const adr = client
        ? [client.adresse, [client.code_postal, client.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ")
        : r.lieu || "";
      item.querySelector("small").textContent = [client ? client.nom : null, adr].filter(Boolean).join(" · ");
      const dest = adr || r.lieu;
      if (dest) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mini-lien";
        b.textContent = "🧭 Y aller";
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          ouvrirMapsVers(dest);
        });
        item.appendChild(b);
      }
      item.addEventListener("click", () => {
        fermer("modal-journee");
        ouvrirModalRdv(r);
      });
      box.appendChild(item);
    });
  }

  /* ---------- Tableau de bord ---------- */
  async function ouvrirDashboard() {
    ouvrir("modal-dashboard");
    const box = $("dash-contenu");
    box.innerHTML = '<p class="p">Chargement…</p>';
    const now = new Date();
    const lundi = new Date(now);
    lundi.setDate(lundi.getDate() - ((lundi.getDay() + 6) % 7));
    lundi.setHours(0, 0, 0, 0);
    const dimanche = new Date(lundi);
    dimanche.setDate(dimanche.getDate() + 7);
    const moisDebut = new Date(now.getFullYear(), now.getMonth(), 1);

    const [sem, iv] = await Promise.all([
      sb.from("agenda").select("assigne_a,type").gte("debut", lundi.toISOString()).lt("debut", dimanche.toISOString()),
      sb.from("interventions").select("statut,montant_devis,created_at"),
    ]);
    const semData = sem.data || [];
    const ivData = iv.data || [];

    const rdvSem = semData.filter((r) => r.type === "rdv").length;
    const chantierSem = semData.filter((r) => r.type === "chantier").length;
    const parTech = {}; // id -> { rdv, chantier }
    semData.forEach((r) => {
      if (r.type === "bloc" || !r.assigne_a) return;
      const t = parTech[r.assigne_a] || (parTech[r.assigne_a] = { rdv: 0, chantier: 0 });
      if (r.type === "chantier") t.chantier++; else t.rdv++;
    });
    const enCours = ivData.filter((i) => i.statut === "en_cours").length;
    const parStatut = {};
    ivData.forEach((i) => (parStatut[i.statut] = (parStatut[i.statut] || 0) + 1));
    const totalMois = ivData
      .filter((i) => i.created_at >= moisDebut.toISOString())
      .reduce((s, i) => s + (Number(i.montant_devis) || 0), 0);

    const maxTech = Math.max(1, ...Object.values(parTech).map((t) => t.rdv + t.chantier));
    const barres = Object.entries(parTech)
      .sort((a, b) => b[1].rdv + b[1].chantier - (a[1].rdv + a[1].chantier))
      .map(([id, t]) => {
        const p = profilsById.get(id);
        const nom = p ? p.nom : "?";
        const col = (p && p.couleur) || "#3b82f6";
        const total = t.rdv + t.chantier;
        const wRdv = Math.round((t.rdv / maxTech) * 100);
        const wCh = Math.round((t.chantier / maxTech) * 100);
        return (
          '<div class="dash-bar"><span class="dash-bar-nom">' + esc(nom) + "</span>" +
          '<span class="dash-bar-piste">' +
          '<span class="dash-bar-jauge" style="width:' + wRdv + "%;background:" + col + '"></span>' +
          '<span class="dash-bar-jauge chantier" style="width:' + wCh + "%;background-color:" + col + '"></span>' +
          "</span>" +
          '<b>' + total + "</b>" +
          '<small class="dash-bar-detail">' + t.rdv + " rdv · " + t.chantier + " ch.</small>" +
          "</div>"
        );
      })
      .join("");

    const STAT_LABEL = { devis: "Devis", en_cours: "En cours", termine: "Terminé", facture: "Facturé", annule: "Annulé" };
    const statuts = Object.entries(parStatut)
      .map(([s, n]) => '<div class="dash-ligne"><span>' + (STAT_LABEL[s] || s) + "</span><b>" + n + "</b></div>")
      .join("");

    box.innerHTML =
      '<div class="dash-tiles">' +
      '<div class="dash-tile"><span class="dash-num">' + rdvSem + '</span><span class="dash-lab">Rendez-vous cette semaine</span></div>' +
      '<div class="dash-tile"><span class="dash-num">' + chantierSem + '</span><span class="dash-lab">Chantiers cette semaine</span></div>' +
      '<div class="dash-tile"><span class="dash-num">' + enCours + '</span><span class="dash-lab">Interventions en cours</span></div>' +
      '<div class="dash-tile"><span class="dash-num">' + totalMois.toFixed(0) + ' €</span><span class="dash-lab">Devis ce mois</span></div>' +
      "</div>" +
      '<div class="titre-bloc sans-marge" style="margin-top:16px">Charge par personne (semaine)</div>' +
      '<div class="dash-legende"><span><i class="pastille-leg pleine"></i> Rendez-vous</span><span><i class="pastille-leg hachuree"></i> Chantiers</span></div>' +
      '<div class="dash-bars">' + (barres || '<div class="vide">Aucun rendez-vous cette semaine.</div>') + "</div>" +
      '<div class="titre-bloc sans-marge" style="margin-top:16px">Interventions par statut</div>' +
      '<div class="dash-statuts">' + (statuts || '<div class="vide">Aucune intervention.</div>') + "</div>";
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  }

  /* ---------- bons d'intervention (admin) ---------- */
  let bonsTab = "atraiter";
  let bonsData = [];

  async function ouvrirBons() {
    bonsTab = "atraiter";
    $("bons-tab-atraiter").classList.add("on");
    $("bons-tab-traites").classList.remove("on");
    $("bons-recherche").value = "";
    $("bons-createur").value = "";
    $("bons-tri").value = "date";
    const selC = $("bons-createur");
    selC.innerHTML = '<option value="">Tous les créateurs</option>';
    [...profilsById.values()].sort((a, b) => (a.nom || "").localeCompare(b.nom || "")).forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.nom;
      selC.appendChild(o);
    });
    await chargerBons();
    ouvrir("modal-bons");
  }

  async function chargerBons() {
    const { data, error } = await sb
      .from("interventions")
      .select("id, titre, statut, client_id, cree_par, created_at, traite, traite_le, rdv_id, signature_path, devis_path")
      .order("created_at", { ascending: false });
    bonsData = error ? [] : data || [];
    rendreBons();
  }

  function rendreBons() {
    const box = $("bons-liste");
    const traites = bonsTab === "traites";
    const terme = $("bons-recherche").value.trim().toLowerCase();
    const createur = $("bons-createur").value;
    const tri = $("bons-tri").value;
    const nomC = (b) => (clientsById.get(b.client_id) || {}).nom || "";
    const auteur = (b) => (profilsById.get(b.cree_par) || {}).nom || "";

    let list = bonsData.filter((b) => !!b.traite === traites);
    if (createur) list = list.filter((b) => b.cree_par === createur);
    if (terme) list = list.filter((b) => nomC(b).toLowerCase().includes(terme));
    if (tri === "client") list.sort((a, b) => nomC(a).localeCompare(nomC(b)));
    else if (tri === "createur") list.sort((a, b) => auteur(a).localeCompare(auteur(b)));
    else list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="vide">Aucun bon ici.</div>';
      return;
    }
    list.forEach((b) => {
      const row = document.createElement("div");
      row.className = "bon-row";
      const info = document.createElement("div");
      info.className = "bon-info";
      const t = document.createElement("b");
      t.textContent = (nomC(b) ? nomC(b) + " · " : "") + b.titre;
      const s = document.createElement("small");
      const date = b.created_at ? new Date(b.created_at).toLocaleDateString("fr-FR") : "";
      s.textContent = [date, "par " + (auteur(b) || "?"), b.signature_path ? "signé" : null, b.devis_path ? "devis" : null]
        .filter(Boolean)
        .join(" · ");
      info.append(t, s);

      const actions = document.createElement("div");
      actions.className = "bon-actions";
      const voir = document.createElement("button");
      voir.type = "button";
      voir.className = "btn-secondaire mini";
      voir.textContent = "Fiche";
      voir.addEventListener("click", () => {
        ficheRetourBons = true;
        fermer("modal-bons");
        ouvrirFicheParId(b.id);
      });
      actions.appendChild(voir);
      const bt = document.createElement("button");
      bt.type = "button";
      if (traites) {
        bt.className = "btn-secondaire mini";
        bt.textContent = "Rouvrir";
        bt.addEventListener("click", () => marquerTraite(b.id, false));
      } else {
        bt.className = "btn-primaire mini";
        bt.textContent = "Marquer traité";
        bt.addEventListener("click", () => marquerTraite(b.id, true));
      }
      actions.appendChild(bt);
      row.append(info, actions);
      box.appendChild(row);
    });
  }

  async function marquerTraite(id, val) {
    const { error } = await sb
      .from("interventions")
      .update({ traite: val, traite_le: val ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) return alert(traduire(error));
    await chargerBons();
  }

  /* ---------- gestion de l'équipe (admin) ---------- */
  async function ouvrirGestionEquipe() {
    messageModal("equipe-message", "");
    await rendreListeMembres();
    ouvrir("modal-equipe");
  }

  async function rendreListeMembres() {
    const { data, error } = await sb
      .from("profils")
      .select("id, nom, email, couleur, role, valide, actif")
      .order("valide", { ascending: true })
      .order("nom");
    const box = $("liste-membres");
    if (error) {
      box.innerHTML = '<p class="vide"></p>';
      box.firstChild.textContent = traduire(error);
      return;
    }
    box.innerHTML = "";
    data.forEach((m) => box.appendChild(ligneMembre(m)));
  }

  function ligneMembre(m) {
    const estMoi = m.id === moi.id;
    const enAttente = !m.valide && m.role !== "admin";
    const ligne = document.createElement("div");
    ligne.className = "membre" + (enAttente ? " en-attente" : "");

    const info = document.createElement("div");
    info.className = "membre-info";
    const b = document.createElement("b");
    b.textContent = m.nom + (estMoi ? " (moi)" : "");
    const s = document.createElement("small");
    s.textContent = m.email || "";
    info.append(b, s);

    const actions = document.createElement("div");
    actions.className = "membre-actions";

    // couleur
    const couleur = document.createElement("input");
    couleur.type = "color";
    couleur.value = m.couleur || COULEUR_DEFAUT;
    couleur.title = "Couleur du membre";
    couleur.addEventListener("change", () => changerCouleur(m.id, couleur.value, couleur, m.couleur));

    // rôle
    const role = document.createElement("select");
    ["membre", "manager", "admin"].forEach((r) => {
      const o = document.createElement("option");
      o.value = r;
      o.textContent = r;
      role.appendChild(o);
    });
    role.value = m.role;
    role.disabled = estMoi; // on ne change pas son propre rôle
    if (!enAttente) role.addEventListener("change", () => changerRole(m.id, role.value));

    actions.append(couleur, role);

    if (enAttente) {
      const valider = document.createElement("button");
      valider.type = "button";
      valider.className = "btn-primaire mini";
      valider.textContent = "Valider";
      valider.addEventListener("click", () => validerMembre(m, role, couleur));
      actions.appendChild(valider);
    } else {
      const lab = document.createElement("label");
      lab.className = "actif-toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = m.actif !== false;
      cb.disabled = m.id === moi.id; // on ne se désactive pas soi-même
      const t = document.createElement("span");
      t.textContent = cb.checked ? "actif" : "inactif";
      cb.addEventListener("change", () => {
        t.textContent = cb.checked ? "actif" : "inactif";
        basculerActif(m.id, cb.checked);
      });
      lab.append(cb, t);
      actions.appendChild(lab);
    }

    // suppression de compte (admin, jamais soi-même)
    if (moi.role === "admin" && m.id !== moi.id) {
      const suppr = document.createElement("button");
      suppr.type = "button";
      suppr.className = "btn-danger mini";
      suppr.textContent = "Supprimer";
      suppr.title = "Supprimer définitivement ce compte";
      suppr.addEventListener("click", () => supprimerCompte(m));
      actions.appendChild(suppr);
    }

    ligne.append(info, actions);
    return ligne;
  }

  async function supprimerCompte(m) {
    if (!confirm('Supprimer définitivement le compte de "' + m.nom + '" ?\nCette action est irréversible.')) return;
    const { data, error } = await sb.functions.invoke("admin-users", { body: { action: "delete_user", profil_id: m.id } });
    if (error) {
      let msg = traduire(error);
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {}
      return messageModal("equipe-message", msg);
    }
    messageModal("equipe-message", "");
    await chargerProfils();
    await rendreListeMembres();
  }

  async function basculerActif(id, actif) {
    const { error } = await sb.from("profils").update({ actif }).eq("id", id);
    if (error) return messageModal("equipe-message", traduire(error));
    await chargerProfils();
  }

  function couleurDejaPrise(couleur, saufId) {
    return [...profilsById.values()].some((p) => p.id !== saufId && p.couleur === couleur);
  }

  async function changerCouleur(id, couleur, input, ancienne) {
    if (couleurDejaPrise(couleur, id)) {
      messageModal("equipe-message", "Cette couleur est déjà prise par un autre membre.");
      input.value = ancienne || COULEUR_DEFAUT;
      return;
    }
    const { error } = await sb.from("profils").update({ couleur }).eq("id", id);
    if (error) {
      messageModal("equipe-message", traduire(error));
      input.value = ancienne || COULEUR_DEFAUT;
      return;
    }
    messageModal("equipe-message", "");
    await chargerProfils();
    rendreEvenements();
  }

  async function changerRole(id, role) {
    const { error } = await sb.from("profils").update({ role }).eq("id", id);
    if (error) return messageModal("equipe-message", traduire(error));
    await chargerProfils();
  }

  async function validerMembre(m, roleSelect, couleurInput) {
    const patch = { valide: true, role: roleSelect.value };
    let couleur = couleurInput.value;
    // si l'admin n'a pas choisi de couleur (encore le gris par défaut) ou si elle est prise,
    // on attribue automatiquement une couleur libre de la palette
    if (couleur === COULEUR_DEFAUT || couleurDejaPrise(couleur, m.id)) couleur = couleurLibre();
    patch.couleur = couleur;
    const { error } = await sb.from("profils").update(patch).eq("id", m.id);
    if (error) return messageModal("equipe-message", traduire(error));
    await chargerProfils();
    rendreEvenements();
    await rendreListeMembres();
  }

  /* ---------- synchronisation agenda (webcal / iCalendar) ---------- */
  function urlFluxAgenda(token) {
    return `${window.CONFIG.SUPABASE_URL}/functions/v1/calendar-feed?token=${token}`;
  }
  function afficherLienSync(token) {
    const https = urlFluxAgenda(token);
    $("sync-url").value = https;
    $("sync-webcal").href = https.replace(/^https:\/\//, "webcal://");
  }
  async function ouvrirSyncAgenda() {
    ouvrir("modal-sync");
    $("sync-url").value = "Chargement…";
    const { data, error } = await sb.rpc("mon_cal_token");
    if (error || !data) {
      $("sync-url").value = "Erreur : " + (error ? traduire(error) : "jeton introuvable");
      return;
    }
    afficherLienSync(data);
  }
  async function copierLienSync() {
    const url = $("sync-url").value;
    if (!url || url.startsWith("Chargement") || url.startsWith("Erreur")) return;
    try {
      await navigator.clipboard.writeText(url);
      const b = $("sync-copier");
      const t = b.textContent;
      b.textContent = "Copié ✓";
      setTimeout(() => (b.textContent = t), 1500);
    } catch (_) {
      $("sync-url").select();
      alert("Copie automatique impossible : sélectionne le lien et copie-le à la main.");
    }
  }
  async function regenererLienSync() {
    if (!confirm("Régénérer le lien ? L'ancien lien cessera de fonctionner et il faudra te réabonner sur tes appareils.")) return;
    const { data, error } = await sb.rpc("regenerer_cal_token");
    if (error || !data) { alert("Erreur : " + (error ? traduire(error) : "réessaie")); return; }
    afficherLienSync(data);
    alert("Nouveau lien généré. Réabonne-toi avec ce nouveau lien sur tes appareils.");
  }

  /* ---------- modales : ouverture / fermeture ---------- */
  function ouvrir(id) { $(id).hidden = false; }
  function fermer(id) {
    $(id).hidden = true;
    if (id === "modal-rdv") planifDepuisInterv = null;
    // fiche ouverte depuis la page Bons -> on y revient
    if (id === "modal-fiche" && ficheRetourBons) {
      ficheRetourBons = false;
      $("modal-bons").hidden = false;
      chargerBons();
    }
  }
  function brancherFermetures() {
    document.querySelectorAll("[data-fermer]").forEach((el) =>
      el.addEventListener("click", () => {
        const modal = el.closest(".modal");
        if (modal) fermer(modal.id);
      })
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") document.querySelectorAll(".modal:not([hidden])").forEach((m) => fermer(m.id));
    });
  }

  /* ---------- init ---------- */
  window.initAgenda = async function (client, profil, traduireErreur) {
    sb = client;
    moi = profil;
    traduire = traduireErreur || ((e) => (e && e.message) || "Erreur");

    initCalendrier();
    brancherFermetures();

    $("btn-nouveau").addEventListener("click", () => ouvrirModalRdv(null));
    $("r-enregistrer").addEventListener("click", enregistrerRdv);
    $("r-supprimer").addEventListener("click", supprimerRdv);
    $("r-vers-attente").addEventListener("click", rdvVersAttente);
    $("r-type").addEventListener("change", basculerType);

    // fiche d'intervention
    $("r-fiche").addEventListener("click", () => {
      if (rdvOuvert) {
        fermer("modal-rdv");
        ouvrirFiche(rdvOuvert);
      }
    });
    $("fiche-enregistrer").addEventListener("click", enregistrerFiche);
    $("fiche-pdf").addEventListener("click", genererPdfFiche);
    $("fiche-ajouter-photo").addEventListener("click", () => $("fiche-photo-input").click());
    $("fiche-photo-input").addEventListener("change", async (e) => {
      await ajouterPhotos([...e.target.files]);
      e.target.value = "";
    });
    $("fiche-devis-dolibarr").addEventListener("click", ouvrirDevisDolibarr);
    $("fiche-devis-lier").addEventListener("click", lierDevisDolibarr);
    $("fiche-devis-annuler").addEventListener("click", () => ($("fiche-devis-picker").hidden = true));
    $("fiche-ajouter-devis").addEventListener("click", () => $("fiche-devis-input").click());
    $("fiche-devis-input").addEventListener("change", async (e) => {
      await ajouterDevis(e.target.files[0]);
      e.target.value = "";
    });
    initSignature();
    $("fiche-sig-effacer").addEventListener("click", () => preparerCanvasSignature());
    $("fiche-sig-refaire").addEventListener("click", () => rendreSignature(null));

    // recherche de client (filtre les listes déroulantes)
    $("r-client-search").addEventListener("input", (e) => rechercherClient("r-client", e.target.value));
    $("a-client-search").addEventListener("input", (e) => rechercherClient("a-client", e.target.value));

    // sélecteur client du RDV : nouveau client OU coordonnées d'un client existant
    $("r-client").addEventListener("change", (e) => {
      const v = e.target.value;
      $("bloc-nouveau-client").hidden = v !== "__nouveau__";
      if (v === "__nouveau__") {
        $("bloc-coord-client").hidden = true;
        coordOriginale = null;
        setTimeout(() => $("r-client-nom").focus(), 30);
      } else if (v === "") {
        $("bloc-coord-client").hidden = true;
        coordOriginale = null;
      } else {
        remplirCoordClient(v);
      }
    });

    // couleur perso : chacun choisit sa couleur (unique)
    const mc = $("moi-couleur");
    if (mc) {
      mc.value = moi.couleur || "#94a3b8";
      mc.addEventListener("change", async () => {
        const c = mc.value;
        if ([...profilsById.values()].some((p) => p.id !== moi.id && p.couleur === c)) {
          alert("Cette couleur est déjà prise par un collègue. Choisis-en une autre.");
          mc.value = moi.couleur || "#94a3b8";
          return;
        }
        const { error } = await sb.from("profils").update({ couleur: c }).eq("id", moi.id);
        if (error) {
          alert("Couleur déjà utilisée ou erreur. Essaie une autre teinte.");
          mc.value = moi.couleur || "#94a3b8";
          return;
        }
        moi.couleur = c;
        await chargerProfils();
        rendreEvenements();
      });
    }

    // navigation Maps
    $("r-maps").addEventListener("click", ouvrirMapsRdv);

    // suivi du temps
    $("fiche-arrivee").addEventListener("change", majDuree);
    $("fiche-depart").addEventListener("change", majDuree);
    $("fiche-arrivee-now").addEventListener("click", () => { $("fiche-arrivee").value = versInput(new Date()); majDuree(); });
    $("fiche-depart-now").addEventListener("click", () => { $("fiche-depart").value = versInput(new Date()); majDuree(); });

    // Ma journée
    $("btn-journee").addEventListener("click", ouvrirJournee);
    $("journee-prec").addEventListener("click", () => bougerJournee(-1));
    $("journee-suiv").addEventListener("click", () => bougerJournee(1));

    // Tableau de bord
    $("btn-dashboard").addEventListener("click", ouvrirDashboard);

    // Synchronisation agenda (abonnement iCalendar / webcal) — réservé aux admins (câblé plus bas)
    $("sync-copier").addEventListener("click", copierLienSync);
    $("sync-regenerer").addEventListener("click", regenererLienSync);

    // vue clients
    $("btn-clients").addEventListener("click", ouvrirClients);
    $("clients-recherche").addEventListener("input", (e) => rendreResultatsClients(e.target.value));
    $("clients-retour").addEventListener("click", () => {
      $("clients-vue-detail").hidden = true;
      $("clients-vue-liste").hidden = false;
    });

    // bons d'intervention (admin)
    $("bons-tab-atraiter").addEventListener("click", () => {
      bonsTab = "atraiter";
      $("bons-tab-atraiter").classList.add("on");
      $("bons-tab-traites").classList.remove("on");
      rendreBons();
    });
    $("bons-tab-traites").addEventListener("click", () => {
      bonsTab = "traites";
      $("bons-tab-traites").classList.add("on");
      $("bons-tab-atraiter").classList.remove("on");
      rendreBons();
    });
    $("bons-recherche").addEventListener("input", rendreBons);
    $("bons-createur").addEventListener("change", rendreBons);
    $("bons-tri").addEventListener("change", rendreBons);

    // réservé aux admins
    if (moi.role === "admin") {
      $("btn-equipe").hidden = false;
      $("btn-equipe").addEventListener("click", ouvrirGestionEquipe);
      $("btn-bons").hidden = false;
      $("btn-bons").addEventListener("click", ouvrirBons);
      $("btn-sync-agenda").hidden = false;
      $("btn-sync-agenda").addEventListener("click", ouvrirSyncAgenda);
    }
    $("btn-signaler").addEventListener("click", () => {
      messageModal("attente-message", "");
      reinitSignalement();
      ouvrir("modal-attente");
    });
    $("a-client").addEventListener("change", (e) => {
      $("bloc-nouveau-client-attente").hidden = e.target.value !== "__nouveau__";
      if (e.target.value === "__nouveau__") setTimeout(() => $("a-client-nom").focus(), 30);
    });
    $("a-enregistrer").addEventListener("click", enregistrerSignalement);
    $("btn-tout").addEventListener("click", () => {
      const tousCoches = profilsById.size && selection.size === profilsById.size;
      selection.clear();
      if (!tousCoches) profilsById.forEach((_, id) => selection.add(id));
      chargerProfils().then(rendreEvenements);
    });
    $("btn-sync").addEventListener("click", async () => {
      const btn = $("btn-sync");
      const txt = btn.textContent;
      btn.disabled = true;
      btn.textContent = "⟳ Sync…";
      const r = await appelDolibarr({ action: "sync" });
      btn.disabled = false;
      btn.textContent = txt;
      if (!r.ok) {
        alert("Import Dolibarr impossible : " + r.error);
        return;
      }
      await chargerClients();
      let msg = r.importes + " client(s) synchronisés depuis Dolibarr.";
      // Admins : on scanne aussi les commandes validées -> affaires à faire
      if (moi.role === "admin") {
        const o = await appelDolibarr({ action: "orders_scan" });
        if (o.ok) {
          msg += "\n" + (o.crees || 0) + " nouvelle(s) affaire(s) depuis les commandes validées.";
          await chargerAttente();
        }
      }
      alert(msg);
    });

    try {
      await chargerProfils();
      await chargerClients();
      await chargerRdv();
      await chargerAttente();
    } catch (err) {
      alert("Chargement de l'agenda impossible : " + traduire(err));
    }

    // Rafraîchissement automatique : au retour dans l'app (téléphone qu'on
    // rouvre, ou RDV ajouté via Siri) et périodiquement tant qu'elle est ouverte.
    let dernierRefresh = Date.now();
    async function rafraichirAuto() {
      if (Date.now() - dernierRefresh < 3000) return; // anti-rafale
      dernierRefresh = Date.now();
      try {
        await chargerRdv();
        await chargerAttente();
      } catch (_) { /* silencieux : on réessaiera */ }
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") rafraichirAuto();
    });
    window.addEventListener("focus", rafraichirAuto);
    setInterval(() => {
      if (document.visibilityState === "visible") rafraichirAuto();
    }, 60000);
  };
})();
