-- Disposable local credentials. Never use these roles or passwords in production.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jw_api_login') THEN
    CREATE ROLE jw_api_login LOGIN PASSWORD 'jw_api_dev' NOBYPASSRLS IN ROLE jw_commerce_api;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jw_experience_login') THEN
    CREATE ROLE jw_experience_login LOGIN PASSWORD 'jw_experience_dev' NOBYPASSRLS IN ROLE jw_experience;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jw_worker_login') THEN
    CREATE ROLE jw_worker_login LOGIN PASSWORD 'jw_worker_dev' NOBYPASSRLS IN ROLE jw_worker;
  END IF;
END $$;
