-- Drop the never-shipped VIDEO_PREVIEW variant (no rows use it) — the
-- chatbot's "put this tile on my floor" preview is images only.
BEGIN;
CREATE TYPE "ChatMediaJobType_new" AS ENUM ('IMAGE_PREVIEW');
ALTER TABLE "ChatMediaJob" ALTER COLUMN "type" TYPE "ChatMediaJobType_new" USING ("type"::text::"ChatMediaJobType_new");
ALTER TYPE "ChatMediaJobType" RENAME TO "ChatMediaJobType_old";
ALTER TYPE "ChatMediaJobType_new" RENAME TO "ChatMediaJobType";
DROP TYPE "ChatMediaJobType_old";
COMMIT;
