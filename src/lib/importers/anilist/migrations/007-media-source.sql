-- AniList MediaSource (ORIGINAL, LIGHT_NOVEL, VISUAL_NOVEL, …) for seasonal scores filters.
ALTER TABLE media ADD COLUMN source TEXT;
CREATE INDEX media_source ON media(source);
