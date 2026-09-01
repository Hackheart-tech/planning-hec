// =====================================================================
//  Edge Function : admin-users
//    { action: "delete_user", profil_id }
//  Supprime un compte (auth + profil en cascade). Réservé aux ADMIN.
//  Interdit de supprimer son propre compte.
// =====================================================================
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
const estUuid = (v: unknown) =>
  typeof v === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // 1. Authentifier l'appelant
    const authHeader = req.headers.get("Authorization") || "";
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: authHeader } });
    if (!uRes.ok) return json({ error: "Non authentifié." }, 401);
    const user = await uRes.json();
    if (!user?.id) return json({ error: "Non authentifié." }, 401);

    // 2. Vérifier que l'appelant est ADMIN
    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/profils?id=eq.${user.id}&select=role`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    const profil = (await pRes.json())[0];
    if (!profil || profil.role !== "admin") return json({ error: "Réservé aux administrateurs." }, 403);

    const body = await req.json().catch(() => ({}));

    if (body.action === "delete_user") {
      if (!estUuid(body.profil_id)) return json({ error: "profil_id invalide." }, 400);
      if (body.profil_id === user.id) return json({ error: "Vous ne pouvez pas supprimer votre propre compte." }, 400);

      // Suppression du compte auth -> cascade sur le profil (FK on delete cascade)
      const del = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${body.profil_id}`, {
        method: "DELETE",
        headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
      });
      if (!del.ok) return json({ error: "Suppression échouée.", detail: (await del.text()).slice(0, 200) }, 502);
      return json({ ok: true });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
