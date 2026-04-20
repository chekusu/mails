-- Adds provider column to outbound email records.
-- Safe for existing deployments; provider=NULL for historical rows.
ALTER TABLE emails ADD COLUMN provider TEXT;
