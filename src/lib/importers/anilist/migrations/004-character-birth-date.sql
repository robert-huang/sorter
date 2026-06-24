-- Fuzzy date-of-birth parts for character rows (favourites birthdays tool).
-- Nullable: many characters have no birthday on AniList.
ALTER TABLE character ADD COLUMN birth_year INTEGER;
ALTER TABLE character ADD COLUMN birth_month INTEGER;
ALTER TABLE character ADD COLUMN birth_day INTEGER;
