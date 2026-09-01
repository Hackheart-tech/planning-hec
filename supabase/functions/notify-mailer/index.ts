// =====================================================================
//  Edge Function : notify-mailer
//  Envoi d'emails via SMTP (implicite TLS, port 465), SANS librairie externe
//  (le déploiement via l'API ne bundle pas les imports distants).
//    { type: "rdv",  id }  -> mail à la personne assignée au RDV
//    { type: "fiche", id } -> fiche transmise à NOTIFY_FICHE_TO
// =====================================================================
const SMTP_HOST = Deno.env.get("SMTP_HOST")!;
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") || "465");
const SMTP_USER = Deno.env.get("SMTP_USER")!;
const SMTP_PASS = Deno.env.get("SMTP_PASS")!;
const MAIL_FROM = Deno.env.get("MAIL_FROM") || SMTP_USER;
const FICHE_TO = Deno.env.get("NOTIFY_FICHE_TO") || SMTP_USER;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
}
function esc(v: unknown) {
  return String(v ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}
function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
async function one(path: string) {
  const j = await (await rest(path)).json();
  return Array.isArray(j) ? j[0] : j;
}
function dateFr(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" });
}
function adresseComplete(c: Record<string, unknown> | null) {
  if (!c) return "";
  const cpVille = [c.code_postal, c.ville].filter(Boolean).join(" ");
  return [c.adresse, cpVille].filter(Boolean).join(", ");
}
async function lienSigne(path: string, sec = 604800): Promise<string | null> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/interventions/${path}`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: sec }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.signedURL ? `${SUPABASE_URL}/storage/v1${j.signedURL}` : null;
}

// ---------- SMTP minimal (TLS implicite) ----------
const enc = new TextEncoder();
function b64(u8: Uint8Array) {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
const b64s = (str: string) => b64(enc.encode(str));
function wrap76(s: string) {
  return (s.match(/.{1,76}/g) || [s]).join("\r\n");
}

async function envoyer(to: string | string[], subject: string, html: string) {
  const rcpts = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
  if (!rcpts.length) throw new Error("Aucun destinataire.");
  const conn = await Deno.connectTls({ hostname: SMTP_HOST, port: SMTP_PORT });
  const dec = new TextDecoder();
  const buf = new Uint8Array(8192);

  async function lire(codes: string[]) {
    let out = "";
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      out += dec.decode(buf.subarray(0, n));
      const lines = out.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) break;
    }
    const code = (out.trim().split(/\r?\n/).pop() || "").slice(0, 3);
    if (!codes.includes(code)) throw new Error(`SMTP ${code}: ${out.trim()}`);
    return out;
  }
  const dire = (s: string) => conn.write(enc.encode(s));

  try {
    await lire(["220"]);
    await dire(`EHLO info-hecmonaco.fr\r\n`); await lire(["250"]);
    await dire(`AUTH LOGIN\r\n`); await lire(["334"]);
    await dire(b64s(SMTP_USER) + "\r\n"); await lire(["334"]);
    await dire(b64s(SMTP_PASS) + "\r\n"); await lire(["235"]);
    await dire(`MAIL FROM:<${MAIL_FROM}>\r\n`); await lire(["250"]);
    // un RCPT par destinataire ; on tolère un rejet individuel (adresse invalide)
    let acceptes = 0;
    for (const rcpt of rcpts) {
      await dire(`RCPT TO:<${rcpt}>\r\n`);
      try { await lire(["250", "251"]); acceptes++; } catch (_) { /* destinataire rejeté, on continue */ }
    }
    if (!acceptes) throw new Error("Aucun destinataire accepté par le serveur.");
    await dire(`DATA\r\n`); await lire(["354"]);

    const entete = [
      `From: Planning HEC <${MAIL_FROM}>`,
      `To: ${rcpts.join(", ")}`,
      `Subject: =?UTF-8?B?${b64s(subject)}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      wrap76(b64s(html)),
    ].join("\r\n");
    await dire(entete + "\r\n.\r\n"); await lire(["250"]);
    await dire(`QUIT\r\n`);
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: authHeader } });
    if (!uRes.ok) return json({ error: "Non authentifié." }, 401);
    const user = await uRes.json();
    if (!user?.id) return json({ error: "Non authentifié." }, 401);
    const profil = await one(`profils?id=eq.${user.id}&select=valide,role`);
    if (!profil || !(profil.valide || profil.role === "admin")) return json({ error: "Compte non validé." }, 403);

    const body = await req.json().catch(() => ({}));
    const estUuid = (v: unknown) =>
      typeof v === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
    if (!estUuid(body.id)) return json({ error: "id invalide." }, 400);

    if (body.type === "rdv") {
      const rdv = await one(`rdv?id=eq.${body.id}&select=titre,debut,fin,lieu,description,assigne_a,client_id`);
      if (!rdv) return json({ error: "RDV introuvable." }, 404);
      const assigne = rdv.assigne_a ? await one(`profils?id=eq.${rdv.assigne_a}&select=nom,email`) : null;
      const client = rdv.client_id ? await one(`clients?id=eq.${rdv.client_id}&select=nom,adresse,code_postal,ville,telephone`) : null;
      const adr = adresseComplete(client);

      // destinataires : soit une liste ciblée (body.only = personnes ajoutées),
      // soit le responsable + toute l'équipe
      const emails: string[] = [];
      const only = Array.isArray(body.only) ? body.only.filter(estUuid) : null;
      if (only && only.length) {
        for (const id of only) {
          const m = await one(`profils?id=eq.${id}&select=email`);
          if (m?.email) emails.push(m.email);
        }
      } else {
        if (assigne?.email) emails.push(assigne.email);
        const parts = await (await rest(`rdv_participants?rdv_id=eq.${body.id}&select=profil_id`)).json();
        for (const pp of Array.isArray(parts) ? parts : []) {
          const m = await one(`profils?id=eq.${pp.profil_id}&select=email`);
          if (m?.email) emails.push(m.email);
        }
      }
      const destinataires = [...new Set(emails)];
      if (!destinataires.length) return json({ ok: true, envoye: false, raison: "Aucun intervenant avec email." });

      const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1d23">
        <p>Bonjour,</p>
        <p>Un rendez-vous est prévu pour votre équipe :</p>
        <ul>
          <li><b>Objet :</b> ${esc(rdv.titre)}</li>
          <li><b>Quand :</b> du ${esc(dateFr(rdv.debut))} au ${esc(dateFr(rdv.fin))}</li>
          ${client ? `<li><b>Client :</b> ${esc(client.nom)}</li>` : ""}
          ${adr ? `<li><b>Adresse :</b> ${esc(adr)}</li>` : ""}
          ${client?.telephone ? `<li><b>Téléphone :</b> ${esc(client.telephone)}</li>` : ""}
          ${rdv.lieu ? `<li><b>Lieu :</b> ${esc(rdv.lieu)}</li>` : ""}
          ${rdv.description ? `<li><b>Notes :</b> ${esc(rdv.description)}</li>` : ""}
        </ul>
        <p style="color:#6b7280">Planning HEC</p></div>`;
      await envoyer(destinataires, `Nouveau rendez-vous : ${rdv.titre}`, html);
      return json({ ok: true, envoye: true, a: destinataires });
    }

    if (body.type === "fiche") {
      const it = await one(`interventions?id=eq.${body.id}&select=titre,montant_devis,statut,notes,client_id,rdv_id,devis_path,signature_path`);
      if (!it) return json({ error: "Fiche introuvable." }, 404);
      const client = it.client_id ? await one(`clients?id=eq.${it.client_id}&select=nom,adresse,code_postal,ville,telephone`) : null;
      const adr = adresseComplete(client);
      const rdv = it.rdv_id ? await one(`rdv?id=eq.${it.rdv_id}&select=titre,debut`) : null;
      const devisUrl = it.devis_path ? await lienSigne(it.devis_path) : null;
      const signUrl = it.signature_path ? await lienSigne(it.signature_path) : null;
      const photos = await (await rest(`intervention_photos?intervention_id=eq.${body.id}&select=storage_path`)).json();
      const photoUrls: string[] = [];
      for (const p of Array.isArray(photos) ? photos : []) {
        const u = await lienSigne(p.storage_path);
        if (u) photoUrls.push(u);
      }

      const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1d23">
        <h2 style="margin:0 0 10px">Fiche d'intervention</h2>
        <ul>
          <li><b>Client :</b> ${esc(client?.nom || "Non renseigné")}</li>
          ${adr ? `<li><b>Adresse :</b> ${esc(adr)}</li>` : ""}
          ${client?.telephone ? `<li><b>Téléphone :</b> ${esc(client.telephone)}</li>` : ""}
          ${rdv ? `<li><b>Rendez-vous :</b> ${esc(rdv.titre)} (${esc(dateFr(rdv.debut))})</li>` : ""}
          <li><b>Intitulé :</b> ${esc(it.titre)}</li>
          <li><b>Statut :</b> ${esc(it.statut)}</li>
          <li><b>Notes :</b> ${esc(it.notes || "Non renseigné")}</li>
        </ul>
        ${devisUrl ? `<p><a href="${devisUrl}">📄 Voir le devis</a></p>` : ""}
        ${signUrl ? `<p><a href="${signUrl}">✍️ Voir la signature</a></p>` : ""}
        ${photoUrls.length ? `<p><b>Photos :</b><br>${photoUrls.map((u, i) => `<a href="${u}">Photo ${i + 1}</a>`).join(" &nbsp; ")}</p>` : "<p>Aucune photo.</p>"}
        <p style="color:#6b7280">Planning HEC</p></div>`;
      // destinataires : adresse dédiée + tous les admins
      const admins = await (await rest(`profils?role=eq.admin&select=email`)).json();
      const adminMails = (Array.isArray(admins) ? admins : []).map((a) => a.email).filter(Boolean);
      const destinataires = [...new Set([FICHE_TO, ...adminMails])];

      await envoyer(destinataires, `Fiche d'intervention : ${client?.nom || ""} - ${it.titre}`, html);
      return json({ ok: true, envoye: true, a: destinataires });
    }

    // --- DOSSIER à planifier : prévenir les admins (sauf le créateur) ---
    if (body.type === "dossier") {
      const it = await one(`interventions?id=eq.${body.id}&select=titre,urgence,notes,client_id,cree_par`);
      if (!it) return json({ error: "Dossier introuvable." }, 404);
      const client = it.client_id ? await one(`clients?id=eq.${it.client_id}&select=nom`) : null;
      const auteur = it.cree_par ? await one(`profils?id=eq.${it.cree_par}&select=nom`) : null;
      const admins = await (await rest(`profils?role=eq.admin&select=id,email`)).json();
      const dest = [...new Set(
        (Array.isArray(admins) ? admins : []).filter((a) => a.email && a.id !== it.cree_par).map((a) => a.email)
      )];
      if (!dest.length) return json({ ok: true, envoye: false, raison: "Aucun admin à prévenir." });
      const URG: Record<string, string> = { urgent: "Urgent", semaine: "Cette semaine", normale: "Quand possible" };
      const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1d23">
        <p>Nouveau dossier à planifier :</p>
        <ul>
          <li><b>Objet :</b> ${esc(it.titre)}</li>
          ${client ? `<li><b>Client :</b> ${esc(client.nom)}</li>` : ""}
          <li><b>Urgence :</b> ${esc(URG[it.urgence] || it.urgence)}</li>
          ${it.notes ? `<li><b>Détails :</b> ${esc(it.notes)}</li>` : ""}
          ${auteur ? `<li><b>Signalé par :</b> ${esc(auteur.nom)}</li>` : ""}
        </ul>
        <p style="color:#6b7280">Planning HEC</p></div>`;
      await envoyer(dest, `Dossier à planifier : ${it.titre}`, html);
      return json({ ok: true, envoye: true, a: dest });
    }

    return json({ error: "Type inconnu." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
