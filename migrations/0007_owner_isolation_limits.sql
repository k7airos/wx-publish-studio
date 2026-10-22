ALTER TABLE accounts ADD CONSTRAINT accounts_owner_identity UNIQUE (owner_id,id);
ALTER TABLE documents ADD CONSTRAINT documents_owner_identity UNIQUE (owner_id,id);
ALTER TABLE identities ADD CONSTRAINT identities_owner_identity UNIQUE (owner_id,id);
ALTER TABLE article_styles ADD CONSTRAINT article_styles_owner_identity UNIQUE (owner_id,id);
ALTER TABLE cover_templates ADD CONSTRAINT cover_templates_owner_identity UNIQUE (owner_id,id);
ALTER TABLE cover_assets ADD CONSTRAINT cover_assets_owner_identity UNIQUE (owner_id,id);
ALTER TABLE article_style_revisions ADD COLUMN owner_id uuid;
UPDATE article_style_revisions r SET owner_id=s.owner_id FROM article_styles s WHERE r.style_id=s.id;
ALTER TABLE article_style_revisions ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE article_style_revisions ADD CONSTRAINT article_style_revision_owner FOREIGN KEY (owner_id,style_id) REFERENCES article_styles(owner_id,id);
ALTER TABLE article_style_revisions ADD CONSTRAINT article_style_revision_identity UNIQUE (owner_id,style_id,revision);
ALTER TABLE cover_template_revisions ADD COLUMN owner_id uuid;
UPDATE cover_template_revisions r SET owner_id=t.owner_id FROM cover_templates t WHERE r.template_id=t.id;
ALTER TABLE cover_template_revisions ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE cover_template_revisions ADD CONSTRAINT cover_revision_owner FOREIGN KEY (owner_id,template_id) REFERENCES cover_templates(owner_id,id);
ALTER TABLE cover_template_revisions ADD CONSTRAINT cover_revision_asset_owner FOREIGN KEY (owner_id,asset_id) REFERENCES cover_assets(owner_id,id);
ALTER TABLE cover_template_revisions ADD CONSTRAINT cover_revision_identity UNIQUE (owner_id,template_id,revision);
ALTER TABLE documents ADD CONSTRAINT documents_style_pair CHECK ((style_id IS NULL)=(style_revision IS NULL));
ALTER TABLE documents ADD CONSTRAINT documents_cover_pair CHECK ((cover_template_id IS NULL)=(cover_template_revision IS NULL));
ALTER TABLE documents ADD CONSTRAINT documents_style_owner FOREIGN KEY (owner_id,style_id,style_revision) REFERENCES article_style_revisions(owner_id,style_id,revision);
ALTER TABLE documents ADD CONSTRAINT documents_cover_owner FOREIGN KEY (owner_id,cover_template_id,cover_template_revision) REFERENCES cover_template_revisions(owner_id,template_id,revision);
ALTER TABLE jobs ADD CONSTRAINT jobs_document_owner FOREIGN KEY (owner_id,document_id) REFERENCES documents(owner_id,id);
ALTER TABLE jobs ADD CONSTRAINT jobs_account_owner FOREIGN KEY (owner_id,account_id) REFERENCES accounts(owner_id,id);
ALTER TABLE jobs ADD CONSTRAINT jobs_credential_identity FOREIGN KEY (account_id,account_revision) REFERENCES account_credentials(account_id,revision);
ALTER TABLE sessions ADD CONSTRAINT sessions_identity_owner FOREIGN KEY (owner_id,identity_id) REFERENCES identities(owner_id,id);
ALTER TABLE accounts ADD COLUMN binding_state text NOT NULL DEFAULT 'bound' CHECK (binding_state IN ('bound','paused','released'));
CREATE TABLE account_bindings (
  app_id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  account_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id,account_id) REFERENCES accounts(owner_id,id)
);
-- 现场若已有跨 owner 同号则迁移明确失败，不猜测归属或删除历史。
INSERT INTO account_bindings (app_id,owner_id,account_id) SELECT app_id,owner_id,id FROM accounts;
CREATE TABLE account_admin_audit (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  app_id text NOT NULL,
  owner_id uuid NOT NULL REFERENCES owners(id),
  account_id text,
  target_owner_id uuid REFERENCES owners(id),
  operator text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cover_assets ADD COLUMN storage_path text;
ALTER TABLE body_assets ADD COLUMN storage_path text;
ALTER TABLE jobs ADD COLUMN worker_publication_requested boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN authorization_revoked boolean NOT NULL DEFAULT false;
