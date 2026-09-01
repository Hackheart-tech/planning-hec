// =====================================================================
//  Edge Function : calendar-feed  (verify_jwt = false)
//  Génère un flux iCalendar (.ics) du planning de l'équipe, pour
//  abonnement depuis Google Agenda / Calendrier du téléphone.
//  Authentification : ?token=<jeton personnel> (table cal_abonnements).
//  Lecture seule. Les RDV privés des autres apparaissent en "Occupé".
// =====================================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function rest(path: string) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
}
async function getJson(path: string) {
  const r = await rest(path);
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j : [];
}

// ------- helpers iCalendar -------
function icsDate(iso: string): string {
  // -> AAAAMMJJThhmmssZ (UTC)
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z"
  );
}
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
// Pliage des lignes à 75 octets (RFC 5545)
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  let out = "";
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > 73) { // marge pour l'espace de continuation
      out += (out ? "\r\n " : "") + cur;
      cur = ch;
    } else {
      cur += ch;
    }
  }
  out += (out ? "\r\n " : "") + cur;
  return out;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  if (!token) {
    return new Response("Lien invalide (jeton manquant).", { status: 400 });
  }

  // 1) Qui demande ? (jeton -> profil)
  const abo = await getJson(
    `cal_abonnements?token=eq.${encodeURIComponent(token)}&select=profil_id`,
  );
  if (!abo.length) {
    return new Response("Lien invalide ou révoqué.", { status: 403 });
  }
  const moi: string = abo[0].profil_id;

  // Réservé aux administrateurs
  const prof = await getJson(`profils?id=eq.${moi}&select=role`);
  if (!prof.length || prof[0].role !== "admin") {
    return new Response("Réservé aux administrateurs.", { status: 403 });
  }

  // 2) RDV de l'équipe (fenêtre : 2 mois passés -> 6 mois futurs)
  const now = new Date();
  const depuis = new Date(now.getTime() - 60 * 864e5).toISOString();
  const jusqua = new Date(now.getTime() + 183 * 864e5).toISOString();
  const rdvs = await getJson(
    `rdv?select=id,titre,description,debut,fin,lieu,assigne_a,client_id,type,statut,prive` +
    `&type=neq.bloc&statut=neq.annule&debut=gte.${depuis}&debut=lte.${jusqua}&order=debut.asc`,
  );

  // 3) Données annexes en lot (équipe, clients, participants)
  const profils = await getJson(`profils?select=id,nom`);
  const nomDe = new Map<string, string>(profils.map((p: any) => [p.id, p.nom]));

  const clientIds = [...new Set(rdvs.map((r: any) => r.client_id).filter(Boolean))];
  const clients = clientIds.length
    ? await getJson(
        `clients?id=in.(${clientIds.join(",")})&select=id,nom,adresse,code_postal,ville,telephone`,
      )
    : [];
  const clientDe = new Map<string, any>(clients.map((c: any) => [c.id, c]));

  const rdvIds = rdvs.map((r: any) => r.id);
  const parts = rdvIds.length
    ? await getJson(
        `rdv_participants?rdv_id=in.(${rdvIds.map((i: string) => `"${i}"`).join(",")})&select=rdv_id,profil_id`,
      )
    : [];
  const participantsDe = new Map<string, string[]>();
  for (const p of parts) {
    const arr = participantsDe.get(p.rdv_id) || [];
    arr.push(p.profil_id);
    participantsDe.set(p.rdv_id, arr);
  }

  // 4) Construction du .ics
  const stamp = icsDate(now.toISOString());
  const lignes: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Planning HEC//Agenda equipe//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Planning HEC",
    "NAME:Planning HEC",
    "X-WR-TIMEZONE:Europe/Paris",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const r of rdvs) {
    const jePeuxVoir =
      !r.prive ||
      r.assigne_a === moi ||
      (participantsDe.get(r.id) || []).includes(moi);

    let resume: string;
    const descLignes: string[] = [];
    let lieu = "";

    if (!jePeuxVoir) {
      resume = "Occupé";
    } else {
      const c = r.client_id ? clientDe.get(r.client_id) : null;
      resume = [r.titre, c?.nom].filter(Boolean).join(" · ") || "Rendez-vous";

      const equipe = [
        r.assigne_a ? nomDe.get(r.assigne_a) : null,
        ...(participantsDe.get(r.id) || []).map((id) => nomDe.get(id)),
      ].filter(Boolean);
      if (equipe.length) descLignes.push("Intervenant(s) : " + equipe.join(", "));
      if (c?.telephone) descLignes.push("Téléphone : " + c.telephone);
      if (r.description) descLignes.push(r.description);

      const adr = c
        ? [c.adresse, [c.code_postal, c.ville].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(", ")
        : "";
      lieu = r.lieu || adr || "";
    }

    lignes.push("BEGIN:VEVENT");
    lignes.push(`UID:${r.id}@info-hecmonaco.fr`);
    lignes.push(`DTSTAMP:${stamp}`);
    lignes.push(`DTSTART:${icsDate(r.debut)}`);
    lignes.push(`DTEND:${icsDate(r.fin)}`);
    lignes.push(fold(`SUMMARY:${esc(resume)}`));
    if (lieu) lignes.push(fold(`LOCATION:${esc(lieu)}`));
    if (descLignes.length) lignes.push(fold(`DESCRIPTION:${esc(descLignes.join("\n"))}`));
    lignes.push("STATUS:CONFIRMED");
    lignes.push("END:VEVENT");
  }

  lignes.push("END:VCALENDAR");
  const body = lignes.join("\r\n") + "\r\n";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="planning-hec.ics"',
      "Cache-Control": "no-cache",
    },
  });
});
