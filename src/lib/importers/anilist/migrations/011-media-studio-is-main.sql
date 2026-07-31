-- AniList StudioEdge.isMain — animation studio vs producer/other credit.
-- NULL means legacy import (nodes-only query) — readers fall back to sort_order.
ALTER TABLE media_studio ADD COLUMN is_main INTEGER;
