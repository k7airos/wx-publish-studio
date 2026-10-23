-- 发布失败时保留 Worker 给出的原因（已脱敏、限长），界面据此告诉使用者该检查什么。
ALTER TABLE jobs ADD COLUMN error_detail text;
