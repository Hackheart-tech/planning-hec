-- =====================================================================
--  012 - Tâches planifiées (pg_cron + pg_net)
--  Rappels avant RDV (toutes les 15 min) + synchro Dolibarr (chaque nuit).
--  NOTE : remplacer <CRON_SECRET> par la valeur du secret CRON_SECRET
--         (défini dans les secrets Supabase). Ne pas committer la vraie valeur.
-- =====================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job
  where jobname in ('agendaboite-rappels', 'agendaboite-sync');

select cron.schedule('agendaboite-rappels', '*/15 * * * *', $CRON$
  select net.http_post(
    url := 'https://qvzhpjmedoqgsopnidbt.functions.supabase.co/cron',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>', 'Content-Type', 'application/json'),
    body := jsonb_build_object('job', 'rappels')
  );
$CRON$);

select cron.schedule('agendaboite-sync', '0 5 * * *', $CRON$
  select net.http_post(
    url := 'https://qvzhpjmedoqgsopnidbt.functions.supabase.co/cron',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>', 'Content-Type', 'application/json'),
    body := jsonb_build_object('job', 'sync')
  );
$CRON$);
