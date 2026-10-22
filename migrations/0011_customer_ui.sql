-- 客户界面：保存统一身份的显示名；文章可归档（任务与快照保留）。
ALTER TABLE identities ADD COLUMN display_name text;
ALTER TABLE documents ADD COLUMN archived_at timestamptz;
