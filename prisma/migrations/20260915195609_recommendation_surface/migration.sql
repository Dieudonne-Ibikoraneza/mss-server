-- Tags which surface (FLOOR/WALL) a Recommendation row is for, within a
-- bathroom floor+wall combo pick. Null for an ordinary single-tile pick —
-- every existing row stays null, which is the correct "not a combo" value.
ALTER TABLE "Recommendation" ADD COLUMN "surface" "RoomSurface";
