-- Agent core realtime read access. service_role receives change events and
-- read access only; writes stay on the existing backend paths.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'medicluster_records'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.medicluster_records;
  END IF;
END $$;

GRANT SELECT ON public.medicluster_records TO service_role;

COMMIT;
