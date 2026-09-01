-- =====================================================================
--  007 - Droits de suppression des RDV
--    membre  : seulement les siens
--    manager : les siens + ceux d'un membre (sauf blocage)
--    admin   : tout
-- =====================================================================
create or replace function public.role_de(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from public.profils where id = uid;
$$;

drop policy if exists rdv_delete on public.rdv;
create policy rdv_delete on public.rdv for delete using (
  public.est_valide() and (
    assigne_a = auth.uid()                                   -- son propre créneau (tous rôles)
    or public.mon_role() = 'admin'                           -- admin : tout
    or (
      public.mon_role() = 'manager'
      and public.role_de(assigne_a) = 'membre'
      and type <> 'bloc'                                     -- manager : RDV d'un membre, hors blocage
    )
  )
);
