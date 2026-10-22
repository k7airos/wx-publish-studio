CREATE TABLE accounts (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  label text NOT NULL,
  app_id text NOT NULL,
  credential_revision integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  synced_revision integer,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, app_id)
);
CREATE TABLE account_credentials (
  account_id text NOT NULL REFERENCES accounts(id),
  revision integer NOT NULL,
  encrypted_secret text NOT NULL,
  worker_account text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, revision)
);
ALTER TABLE jobs ADD COLUMN account_revision integer;
ALTER TABLE jobs ADD COLUMN worker_account text;
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value text NOT NULL
);
