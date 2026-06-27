-- Per-entry list notes (e.g. #airing tags) for seasonal scores DB reads.
ALTER TABLE media_list_entry ADD COLUMN notes TEXT;
