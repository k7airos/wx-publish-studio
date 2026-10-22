CREATE TABLE IF NOT EXISTS owners (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  title text NOT NULL,
  body text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  document_revision integer NOT NULL,
  account_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL,
  worker_job_id text,
  status text NOT NULL,
  step text NOT NULL DEFAULT 'submitting',
  error_code text,
  draft_media_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  simulated boolean NOT NULL DEFAULT false,
  UNIQUE (document_id, document_revision, account_id)
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;
