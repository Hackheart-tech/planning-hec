// =====================================================================
//  Edge Function : dolibarr-sync
//  Pont sécurisé app <-> Dolibarr (clé API côté serveur uniquement).
//  Sans dépendance externe : uniquement fetch.
//    { action: "sync" }                     -> importe les clients Dolibarr
//    { action: "create", nom, email, tel }  -> crée un client dans Dolibarr + local
// =====================================================================
const DOLIBARR_URL = Deno.env.get("DOLIBARR_URL")!;
const DOLIBARR_API_KEY = Deno.env.get("DOLIBARR_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// Validation des identifiants (anti-injection / anti-traversée)
const estUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
const estEntierPositif = (v: unknown) => /^[0-9]+$/.test(String(v));

function doli(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${DOLIBARR_URL}/api/index.php${path}`, {
    ...init,
    headers: { DOLAPIKEY: DOLIBARR_API_KEY, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// Appel PostgREST avec la clé service_role
function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1. Authentifier l'appelant via son JWT
    const authHeader = req.headers.get("Authorization") || "";
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: authHeader },
    });
    if (!uRes.ok) return json({ error: "Non authentifié." }, 401);
    const user = await uRes.json();
    if (!user?.id) return json({ error: "Non authentifié." }, 401);

    // 2. Vérifier que le compte est validé
    const pRes = await rest(`profils?id=eq.${user.id}&select=valide,role`);
    const profils = await pRes.json();
    const profil = Array.isArray(profils) ? profils[0] : null;
    if (!profil || !(profil.valide || profil.role === "admin")) {
      return json({ error: "Compte non validé." }, 403);
    }

    const body = await req.json().catch(() => ({}));

    // 3. SYNC : importer les clients depuis Dolibarr
    if (body.action === "sync") {
      const res = await doli(`/thirdparties?limit=2000`);
      const tiers = await res.json();
      if (!Array.isArray(tiers)) return json({ error: "Réponse Dolibarr inattendue.", detail: tiers }, 502);

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
        if (!up.ok) return json({ error: "Enregistrement local échoué.", detail: await up.text() }, 500);
      }
      return json({ ok: true, importes: rows.length });
    }

    // 4. CREATE : créer un client dans Dolibarr puis en local
    if (body.action === "create") {
      const nom = (body.nom || "").trim();
      if (!nom) return json({ error: "Nom requis." }, 400);

      const res = await doli(`/thirdparties`, {
        method: "POST",
        body: JSON.stringify({
          name: nom,
          email: body.email || undefined,
          phone: body.tel || undefined,
          address: body.adresse || undefined,
          zip: body.code_postal || undefined,
          town: body.ville || undefined,
          client: 1,
          status: 1,
        }),
      });
      const txt = await res.text();
      if (!res.ok) return json({ error: "Création Dolibarr échouée.", detail: txt }, 502);

      const dolibarrId = Number(JSON.parse(txt));
      const ins = await rest(`clients`, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          dolibarr_id: dolibarrId,
          nom,
          email: body.email || null,
          telephone: body.tel || null,
          adresse: body.adresse || null,
          code_postal: body.code_postal || null,
          ville: body.ville || null,
        }),
      });
      const insJson = await ins.json();
      if (!ins.ok) return json({ error: "Enregistrement local échoué.", detail: insJson }, 500);

      const created = Array.isArray(insJson) ? insJson[0] : insJson;
      return json({ ok: true, id: created.id, nom: created.nom, dolibarr_id: dolibarrId });
    }

    // 5. UPDATE : corriger les coordonnées d'un client (local + Dolibarr)
    if (body.action === "update") {
      const clientId = body.client_id;
      if (!estUuid(clientId)) return json({ error: "client_id invalide." }, 400);

      const cRes = await rest(`clients?id=eq.${clientId}&select=dolibarr_id`);
      const c = (await cRes.json())[0];

      // Dolibarr (seulement les champs fournis)
      if (c?.dolibarr_id) {
        const dbody: Record<string, unknown> = {};
        if (body.email !== undefined) dbody.email = body.email;
        if (body.tel !== undefined) dbody.phone = body.tel;
        if (body.adresse !== undefined) dbody.address = body.adresse;
        if (body.code_postal !== undefined) dbody.zip = body.code_postal;
        if (body.ville !== undefined) dbody.town = body.ville;
        if (Object.keys(dbody).length) {
          const dr = await doli(`/thirdparties/${c.dolibarr_id}`, { method: "PUT", body: JSON.stringify(dbody) });
          if (!dr.ok) return json({ error: "Mise à jour Dolibarr échouée.", detail: await dr.text() }, 502);
        }
      }

      // local
      const lbody: Record<string, unknown> = {};
      if (body.email !== undefined) lbody.email = body.email || null;
      if (body.tel !== undefined) lbody.telephone = body.tel || null;
      if (body.adresse !== undefined) lbody.adresse = body.adresse || null;
      if (body.code_postal !== undefined) lbody.code_postal = body.code_postal || null;
      if (body.ville !== undefined) lbody.ville = body.ville || null;
      if (Object.keys(lbody).length) {
        await rest(`clients?id=eq.${clientId}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(lbody),
        });
      }
      return json({ ok: true });
    }

    // 6. DEVIS_CLIENT : liste les devis (propositions) d'un client depuis Dolibarr
    if (body.action === "devis_client") {
      if (!estUuid(body.client_id)) return json({ error: "client_id invalide." }, 400);
      const c = (await (await rest(`clients?id=eq.${body.client_id}&select=dolibarr_id`)).json())[0];
      if (!c?.dolibarr_id) return json({ ok: true, devis: [] });
      const filt = encodeURIComponent(`(t.fk_soc:=:${c.dolibarr_id})`);
      const res = await doli(`/proposals?sqlfilters=${filt}&limit=100`);
      const arr = await res.json();
      if (!Array.isArray(arr)) return json({ ok: true, devis: [] });
      const devis = arr
        .map((p: Record<string, unknown>) => ({
          id: Number(p.id),
          ref: (p.ref as string) || "(sans réf)",
          montant: p.total_ttc ? Number(p.total_ttc) : null,
          date: p.date ? Number(p.date) * 1000 : null,
          statut: p.statut,
          aPdf: !!p.last_main_doc,
        }))
        .sort((a, b) => (b.date || 0) - (a.date || 0));
      return json({ ok: true, devis });
    }

    // 7. DEVIS_LIER : rattache un devis Dolibarr à l'intervention (montant + PDF)
    if (body.action === "devis_lier") {
      const interventionId = body.intervention_id;
      const proposalId = body.proposal_id;
      if (!estUuid(interventionId)) return json({ error: "intervention_id invalide." }, 400);
      if (!estEntierPositif(proposalId)) return json({ error: "proposal_id invalide." }, 400);

      const pRes = await doli(`/proposals/${proposalId}`);
      if (!pRes.ok) return json({ error: "Devis introuvable dans Dolibarr." }, 502);
      const p = await pRes.json();

      const patch: Record<string, unknown> = {
        dolibarr_proposal_id: Number(proposalId),
        montant_devis: p.total_ttc ? Number(p.total_ttc) : null,
      };

      // récupère le PDF si disponible et le stocke
      if (p.last_main_doc) {
        const orig = String(p.last_main_doc).replace(/^propale\//, "");
        const dl = await doli(`/documents/download?modulepart=propal&original_file=${encodeURIComponent(orig)}`);
        if (dl.ok) {
          const j = await dl.json();
          if (j.content) {
            const bytes = Uint8Array.from(atob(j.content), (ch) => ch.charCodeAt(0));
            const path = `${interventionId}/devis/${String(p.ref || "devis").replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
            const up = await fetch(`${SUPABASE_URL}/storage/v1/object/interventions/${path}`, {
              method: "POST",
              headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/pdf", "x-upsert": "true" },
              body: bytes,
            });
            if (up.ok) patch.devis_path = path;
          }
        }
      }

      const u = await rest(`interventions?id=eq.${interventionId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      });
      if (!u.ok) return json({ error: "Mise à jour intervention échouée.", detail: await u.text() }, 500);

      return json({ ok: true, ref: p.ref, montant: patch.montant_devis, devis_path: patch.devis_path || null });
    }

    // 8. ORDERS_SCAN : (admin) déclenche le scan des commandes Dolibarr validées
    if (body.action === "orders_scan") {
      if (profil.role !== "admin") return json({ error: "Réservé aux admins." }, 403);
      const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
      const r = await fetch(`${SUPABASE_URL}/functions/v1/cron`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`,
          "x-cron-secret": CRON_SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ job: "orders" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: j.error || "Scan des commandes échoué." }, 502);
      return json({ ok: true, ...j });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
