-- Unique indexes for pharmacy staff accounts
CREATE UNIQUE INDEX IF NOT EXISTS medicluster_staff_email
  ON public.medicluster_records (lower(btrim(data ->> 'email')))
  WHERE collection = 'pharmacystaffs' AND data ? 'email' AND data ->> 'email' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS medicluster_staff_phone
  ON public.medicluster_records ((data -> 'phone'))
  WHERE collection = 'pharmacystaffs' AND data ? 'phone' AND data ->> 'phone' IS NOT NULL;
