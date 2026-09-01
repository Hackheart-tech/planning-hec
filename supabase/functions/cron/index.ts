// =====================================================================
//  Edge Function : cron  (déclenchée par pg_cron, protégée par un secret)
//    body { job: "rappels" } -> mail de rappel aux personnes ayant un RDV
//                               qui commence dans l'heure (une seule fois)
//    body { job: "sync" }    -> import automatique des clients Dolibarr
// =====================================================================
const SMTP_HOST = Deno.env.get("SMTP_HOST")!;
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") || "465");
const SMTP_USER = Deno.env.get("SMTP_USER")!;
const SMTP_PASS = Deno.env.get("SMTP_PASS")!;
const MAIL_FROM = Deno.env.get("MAIL_FROM") || SMTP_USER;
const DOLIBARR_URL = Deno.env.get("DOLIBARR_URL")!;
const DOLIBARR_API_KEY = Deno.env.get("DOLIBARR_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
}
function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
function doli(path: string, init: RequestInit = {}) {
  return fetch(`${DOLIBARR_URL}/api/index.php${path}`, {
    ...init,
    headers: { DOLAPIKEY: DOLIBARR_API_KEY, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
function dateFr(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });
}
const esc = (v: unknown) => String(v ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

// ---------- SMTP minimal (TLS implicite) ----------
const enc = new TextEncoder();
function b64(u8: Uint8Array) { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); }
const b64s = (str: string) => b64(enc.encode(str));
const wrap76 = (s: string) => (s.match(/.{1,76}/g) || [s]).join("\r\n");

async function envoyer(to: string, subject: string, html: string) {
  const conn = await Deno.connectTls({ hostname: SMTP_HOST, port: SMTP_PORT });
  const dec = new TextDecoder();
  const buf = new Uint8Array(8192);
  async function lire(codes: string[]) {
    let out = "";
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      out += dec.decode(buf.subarray(0, n));
      const last = out.split(/\r?\n/).filter(Boolean).pop() || "";
      if (/^\d{3} /.test(last)) break;
    }
    const code = (out.trim().split(/\r?\n/).pop() || "").slice(0, 3);
    if (!codes.includes(code)) throw new Error(`SMTP ${code}`);
  }
  const dire = (s: string) => conn.write(enc.encode(s));
  try {
    await lire(["220"]);
    await dire(`EHLO info-hecmonaco.fr\r\n`); await lire(["250"]);
    await dire(`AUTH LOGIN\r\n`); await lire(["334"]);
    await dire(b64s(SMTP_USER) + "\r\n"); await lire(["334"]);
    await dire(b64s(SMTP_PASS) + "\r\n"); await lire(["235"]);
    await dire(`MAIL FROM:<${MAIL_FROM}>\r\n`); await lire(["250"]);
    await dire(`RCPT TO:<${to}>\r\n`); await lire(["250", "251"]);
    await dire(`DATA\r\n`); await lire(["354"]);
    const entete = [
      `From: Planning HEC <${MAIL_FROM}>`, `To: ${to}`,
      `Subject: =?UTF-8?B?${b64s(subject)}?=`, `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`, `Content-Transfer-Encoding: base64`, ``,
      wrap76(b64s(html)),
    ].join("\r\n");
    await dire(entete + "\r\n.\r\n"); await lire(["250"]);
    await dire(`QUIT\r\n`);
  } finally { try { conn.close(); } catch (_) {} }
}
async function one(path: string) { const j = await (await rest(path)).json(); return Array.isArray(j) ? j[0] : j; }

Deno.serve(async (req) => {
  // Authentification : secret cron uniquement
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "Interdit." }, 401);
  const body = await req.json().catch(() => ({}));

  try {
    // ---------- RAPPELS ----------
    if (body.job === "rappels") {
      const maintenant = new Date();
      const dansUneHeure = new Date(maintenant.getTime() + 60 * 60 * 1000);
      const rdvs = await (await rest(
        `rdv?select=id,titre,debut,fin,lieu,assigne_a,client_id&type=neq.bloc&statut=neq.annule&rappel_envoye=eq.false` +
        `&debut=gte.${maintenant.toISOString()}&debut=lte.${dansUneHeure.toISOString()}`
      )).json();
      let envoyes = 0;
      for (const r of Array.isArray(rdvs) ? rdvs : []) {
        // destinataires : responsable + équipe
        const emails: string[] = [];
        if (r.assigne_a) { const p = await one(`profils?id=eq.${r.assigne_a}&select=email`); if (p?.email) emails.push(p.email); }
        const parts = await (await rest(`rdv_participants?rdv_id=eq.${r.id}&select=profil_id`)).json();
        for (const pp of Array.isArray(parts) ? parts : []) {
          const m = await one(`profils?id=eq.${pp.profil_id}&select=email`);
          if (m?.email) emails.push(m.email);
        }
        const dest = [...new Set(emails)];
        if (!dest.length) continue;
        const c = r.client_id ? await one(`clients?id=eq.${r.client_id}&select=nom,adresse,code_postal,ville,telephone`) : null;
        const adr = c ? [c.adresse, [c.code_postal, c.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
        const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1d23">
          <p>Bonjour,</p>
          <p><b>Rappel</b> : rendez-vous dans moins d'une heure.</p>
          <ul>
            <li><b>Objet :</b> ${esc(r.titre)}</li>
            <li><b>Heure :</b> ${esc(dateFr(r.debut))}</li>
            ${c ? `<li><b>Client :</b> ${esc(c.nom)}</li>` : ""}
            ${adr ? `<li><b>Adresse :</b> ${esc(adr)}</li>` : ""}
            ${c?.telephone ? `<li><b>Téléphone :</b> ${esc(c.telephone)}</li>` : ""}
            ${r.lieu ? `<li><b>Lieu :</b> ${esc(r.lieu)}</li>` : ""}
          </ul>
          <p style="color:#6b7280">Planning HEC</p>
        </div>`;
        try {
          for (const to of dest) await envoyer(to, `Rappel : ${r.titre} (${dateFr(r.debut)})`, html);
          await rest(`rdv?id=eq.${r.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ rappel_envoye: true }) });
          envoyes++;
        } catch (_) { /* on réessaiera au prochain passage */ }
      }
      return json({ ok: true, rappels_envoyes: envoyes });
    }

    // ---------- SYNC clients Dolibarr ----------
    if (body.job === "sync") {
      const tiers = await (await doli(`/thirdparties?limit=2000`)).json();
      if (!Array.isArray(tiers)) return json({ error: "Réponse Dolibarr inattendue." }, 502);
      const rows = tiers.map((t: Record<string, unknown>) => ({
        dolibarr_id: Number(t.id),
        nom: (t.name as string) || "(sans nom)",
        email: (t.email as string) || null,
        telephone: (t.phone as string) || null,
        adresse: (t.address as string) || null,
        code_postal: (t.zip as string) || null,
        ville: (t.town as string) || null,
      }));
      if (rows.length) {
        const up = await rest(`clients?on_conflict=dolibarr_id`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows),
        });
        if (!up.ok) return json({ error: await up.text() }, 500);
      }
      return json({ ok: true, importes: rows.length });
    }

    // ---------- ORDERS : commandes Dolibarr validées -> affaires à faire (admins) ----------
    if (body.job === "orders") {
      // 1. commandes validées (statut >= 1)
      const filt = encodeURIComponent(`(t.fk_statut:>=:1)`);
      const cmds = await (await doli(`/orders?sqlfilters=${filt}&limit=200&sortfield=t.rowid&sortorder=DESC`)).json();
      if (!Array.isArray(cmds)) return json({ ok: true, crees: 0, note: "aucune commande" });

      const maxId = cmds.reduce((m: number, o: Record<string, unknown>) => Math.max(m, Number(o.id) || 0), 0);

      // Référence de départ : au tout premier passage on la pose SANS rien créer
      // (sinon tout l'historique des commandes deviendrait des affaires à faire).
      const cfg = await (await rest(`app_config?cle=eq.commandes_baseline&select=valeur`)).json();
      const baseline = Array.isArray(cfg) && cfg[0] ? Number(cfg[0].valeur) : null;
      if (baseline === null) {
        await rest(`app_config`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ cle: "commandes_baseline", valeur: String(maxId) }),
        });
        return json({ ok: true, baseline_pose: maxId, crees: 0 });
      }

      // On ne traite que les commandes PLUS RÉCENTES que la référence.
      const recentes = cmds.filter((o: Record<string, unknown>) => Number(o.id) > baseline);

      // 2. lesquelles déjà transformées en affaire ?
      const ids = recentes.map((o: Record<string, unknown>) => Number(o.id)).filter(Boolean);
      let dejaFaits = new Set<number>();
      if (ids.length) {
        const rows = await (await rest(`interventions?select=dolibarr_order_id&dolibarr_order_id=in.(${ids.join(",")})`)).json();
        dejaFaits = new Set((Array.isArray(rows) ? rows : []).map((r) => Number(r.dolibarr_order_id)));
      }

      // 3. correspondance client local par dolibarr_id (socid)
      const socids = [...new Set(recentes.map((o: Record<string, unknown>) => Number(o.socid)).filter(Boolean))];
      const clientMap = new Map<number, string>();
      if (socids.length) {
        const cs = await (await rest(`clients?select=id,dolibarr_id&dolibarr_id=in.(${socids.join(",")})`)).json();
        (Array.isArray(cs) ? cs : []).forEach((c) => clientMap.set(Number(c.dolibarr_id), c.id));
      }

      const nouveaux: Record<string, unknown>[] = [];
      for (const o of recentes) {
        const oid = Number(o.id);
        if (!oid || dejaFaits.has(oid)) continue;
        let clientLocalId = clientMap.get(Number(o.socid)) || null;
        // client pas encore en local -> on l'importe à la volée
        if (!clientLocalId && o.socid) {
          const tRes = await doli(`/thirdparties/${Number(o.socid)}`);
          if (tRes.ok) {
            const t = await tRes.json();
            const ins = await rest(`clients?on_conflict=dolibarr_id`, {
              method: "POST",
              headers: { Prefer: "resolution=merge-duplicates,return=representation" },
              body: JSON.stringify([{
                dolibarr_id: Number(t.id), nom: t.name || "(sans nom)", email: t.email || null,
                telephone: t.phone || null, adresse: t.address || null, code_postal: t.zip || null, ville: t.town || null,
              }]),
            });
            const cj = await ins.json();
            const cc = Array.isArray(cj) ? cj[0] : cj;
            clientLocalId = cc?.id || null;
          }
        }
        const ref = (o.ref as string) || ("CMD-" + oid);
        const montant = o.total_ttc ? Number(o.total_ttc) : null;
        nouveaux.push({
          titre: "Devis validé — " + ref,
          client_id: clientLocalId,
          notes: "Commande Dolibarr " + ref + (montant != null ? " — " + montant.toFixed(2) + " € TTC" : ""),
          urgence: "semaine",
          statut: "devis",
          origine: "dolibarr_commande",
          admin_seulement: true,
          dolibarr_order_id: oid,
          cree_par: null,
        });
      }

      let crees = 0;
      if (nouveaux.length) {
        const insRes = await rest(`interventions`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(nouveaux),
        });
        const ins = await insRes.json();
        if (!insRes.ok) return json({ error: "Insertion échouée.", detail: ins }, 500);
        crees = Array.isArray(ins) ? ins.length : 0;

        // 4. prévenir les admins par mail (un récap)
        if (crees) {
          const admins = await (await rest(`profils?role=eq.admin&select=email`)).json();
          const dest = [...new Set((Array.isArray(admins) ? admins : []).map((a) => a.email).filter(Boolean))];
          if (dest.length) {
            const lignes = (Array.isArray(ins) ? ins : []).map((it) => `<li>${esc(it.titre)}</li>`).join("");
            const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1a1d23">
              <p>${crees} nouvelle(s) affaire(s) à planifier (devis transformés en commande dans Dolibarr) :</p>
              <ul>${lignes}</ul>
              <p>Elles apparaissent dans « Dossiers en attente » du Planning HEC.</p>
              <p style="color:#6b7280">Planning HEC</p></div>`;
            try { await envoyer(dest, `${crees} affaire(s) à planifier (Dolibarr)`, html); } catch (_) { /* best effort */ }
          }
        }
      }

      // Avancer la référence de départ pour ne pas re-scanner ces commandes.
      if (maxId > baseline) {
        await rest(`app_config?cle=eq.commandes_baseline`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ valeur: String(maxId) }),
        });
      }
      return json({ ok: true, commandes_vues: recentes.length, crees });
    }

    return json({ error: "job inconnu." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
