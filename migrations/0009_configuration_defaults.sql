CREATE TABLE owner_configuration_defaults (
  owner_id uuid PRIMARY KEY REFERENCES owners(id),
  style_id uuid,
  style_revision integer,
  cover_template_id uuid,
  cover_template_revision integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, style_id, style_revision)
    REFERENCES article_style_revisions(owner_id, style_id, revision),
  FOREIGN KEY (owner_id, cover_template_id, cover_template_revision)
    REFERENCES cover_template_revisions(owner_id, template_id, revision),
  CHECK ((style_id IS NULL) = (style_revision IS NULL)),
  CHECK ((cover_template_id IS NULL) = (cover_template_revision IS NULL))
);
