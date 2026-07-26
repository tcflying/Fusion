DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime')
     AND to_regclass('public.fusion_schema_migrations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public.fusion_schema_migrations
      FROM fusion_runtime;

    GRANT SELECT
      ON public.fusion_schema_migrations
      TO fusion_runtime;
  END IF;
END
$$;
