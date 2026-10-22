CREATE TABLE identities (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject),
  UNIQUE (owner_id, issuer)
);
CREATE TABLE product_memberships (
  owner_id uuid PRIMARY KEY REFERENCES owners(id),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO product_memberships (owner_id,status,role)
  SELECT id,'active','admin' FROM owners WHERE id='00000000-0000-4000-8000-000000000001';
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD CONSTRAINT sessions_id_unique UNIQUE (id);
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'bootstrap' CHECK (auth_method IN ('bootstrap', 'oauth'));
ALTER TABLE sessions ADD COLUMN identity_id uuid REFERENCES identities(id);
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE oauth_pending_states (
  state_hash text PRIMARY KEY,
  browser_binding_hash text NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity_admin_audit (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id),
  issuer text,
  subject text,
  operator text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
