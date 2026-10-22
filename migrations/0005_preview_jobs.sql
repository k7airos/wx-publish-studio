CREATE TABLE body_assets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  sha256 text NOT NULL,
  content_type text NOT NULL,
  byte_length integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE jobs ADD COLUMN operation text;
ALTER TABLE jobs ADD COLUMN article_snapshot jsonb;
ALTER TABLE jobs ADD COLUMN input_hash text;
ALTER TABLE jobs ADD COLUMN snapshot_hash text;
ALTER TABLE jobs ADD COLUMN artifact_manifest jsonb;
ALTER TABLE jobs ADD COLUMN artifact_manifest_hash text;
ALTER TABLE jobs ADD COLUMN publication_requested boolean NOT NULL DEFAULT false;
