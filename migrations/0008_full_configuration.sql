ALTER TABLE cover_template_revisions ALTER COLUMN controls DROP NOT NULL;
ALTER TABLE cover_template_revisions ALTER COLUMN asset_id DROP NOT NULL;
ALTER TABLE cover_template_revisions ADD COLUMN config jsonb;
ALTER TABLE cover_template_revisions ADD COLUMN slot text NOT NULL DEFAULT 'article_cover';
ALTER TABLE cover_template_revisions ADD CONSTRAINT cover_template_schema CHECK (
  (schema_version=1 AND controls IS NOT NULL AND asset_id IS NOT NULL AND config IS NULL AND slot='article_cover') OR
  (schema_version=2 AND controls IS NULL AND asset_id IS NULL AND config IS NOT NULL AND slot IN ('article_cover','newspic_cover','newspic_content'))
);
ALTER TABLE body_assets ADD CONSTRAINT body_assets_owner_identity UNIQUE (owner_id,id);
CREATE TABLE cover_template_assets (
  owner_id uuid NOT NULL,
  template_id uuid NOT NULL,
  revision integer NOT NULL,
  asset_id uuid NOT NULL,
  PRIMARY KEY (template_id,revision,asset_id),
  FOREIGN KEY (owner_id,template_id,revision) REFERENCES cover_template_revisions(owner_id,template_id,revision),
  FOREIGN KEY (owner_id,asset_id) REFERENCES body_assets(owner_id,id)
);
