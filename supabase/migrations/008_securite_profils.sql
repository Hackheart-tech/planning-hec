-- =====================================================================
--  008 - Sécurité : empêcher l'auto-escalade de privilèges sur profils
--  Un non-admin ne peut PAS changer son role ni sa validation (valide),
--  ni s'insérer avec un role/valide privilégié. Le service (backend) et
--  les admins gardent tous les droits.
-- =====================================================================
create or replace function public.protege_profil()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() null = appel backend (service_role / SQL) => on laisse faire
  if auth.uid() is not null and coalesce(public.mon_role(), '') <> 'admin' then
    if TG_OP = 'INSERT' then
      NEW.role := 'membre';
      NEW.valide := false;
    elsif TG_OP = 'UPDATE' then
      NEW.role := OLD.role;     -- interdit de changer son rôle
      NEW.valide := OLD.valide; -- interdit de s'auto-valider
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists profils_protege on public.profils;
create trigger profils_protege before insert or update on public.profils
  for each row execute function public.protege_profil();
