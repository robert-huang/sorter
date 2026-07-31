-- Marks that studio edges (with isMain) were imported or repaired for this row.
-- NULL means we have never fetched studios — distinct from zero-studio media,
-- which still gets a timestamp after a successful repair/import.
ALTER TABLE media ADD COLUMN studios_fetched_at INTEGER;
