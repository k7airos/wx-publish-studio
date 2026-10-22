CREATE TABLE article_styles (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  name text NOT NULL,
  current_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE article_style_revisions (
  style_id uuid NOT NULL REFERENCES article_styles(id),
  revision integer NOT NULL,
  article_style jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (style_id, revision)
);
ALTER TABLE documents ADD COLUMN style_id uuid;
ALTER TABLE documents ADD COLUMN style_revision integer;
ALTER TABLE documents ADD CONSTRAINT documents_article_style_revision
  FOREIGN KEY (style_id, style_revision) REFERENCES article_style_revisions(style_id, revision);
ALTER TABLE jobs ADD COLUMN article_style jsonb;
ALTER TABLE jobs ADD COLUMN article_style_hash text;
ALTER TABLE jobs ADD COLUMN article_theme_hash text;
