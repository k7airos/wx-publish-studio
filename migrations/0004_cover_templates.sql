CREATE TABLE cover_assets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  sha256 text NOT NULL,
  source_sha256 text NOT NULL,
  byte_length integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cover_templates (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  name text NOT NULL,
  current_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cover_template_revisions (
  template_id uuid NOT NULL REFERENCES cover_templates(id),
  revision integer NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  controls jsonb NOT NULL,
  asset_id uuid NOT NULL REFERENCES cover_assets(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, revision)
);
ALTER TABLE documents ADD COLUMN cover_template_id uuid;
ALTER TABLE documents ADD COLUMN cover_template_revision integer;
ALTER TABLE documents ADD CONSTRAINT documents_cover_template_revision
  FOREIGN KEY (cover_template_id, cover_template_revision) REFERENCES cover_template_revisions(template_id, revision);
ALTER TABLE jobs ADD COLUMN cover_snapshot jsonb;
ALTER TABLE jobs ADD COLUMN cover_snapshot_hash text;
ALTER TABLE jobs ADD COLUMN cover_asset_hash text;
ALTER TABLE jobs ADD COLUMN cover_font_hash text;
