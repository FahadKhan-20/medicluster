-- Live dispatch: crew assignments and ambulance positions reach the dispatch map
-- and the crew app as soon as they change. Realtime still applies each table's
-- row-level security, so a crew only receives its own ambulance and incident.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ambulances', 'incidents'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END;
$$;
