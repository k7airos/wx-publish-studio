-- 邀请准入：成员资格可带有效期。已有成员均为手工开通、不限期，行为不变。
ALTER TABLE product_memberships ADD COLUMN access_source text NOT NULL DEFAULT 'manual' CHECK (access_source IN ('manual', 'nezus_membership'));
ALTER TABLE product_memberships ADD COLUMN access_until timestamptz;
ALTER TABLE product_memberships ADD COLUMN entitlement_synced_at timestamptz;
-- 终态任务清理大字段后记录时间，保留身份、幂等键与 hash。
ALTER TABLE jobs ADD COLUMN pruned_at timestamptz;
