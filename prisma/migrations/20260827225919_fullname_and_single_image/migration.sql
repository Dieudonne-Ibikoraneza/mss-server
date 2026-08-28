-- User: firstName + lastName -> fullName
ALTER TABLE "User" ADD COLUMN "fullName" TEXT;
UPDATE "User" SET "fullName" = TRIM(CONCAT("firstName", ' ', "lastName"));
ALTER TABLE "User" ALTER COLUMN "fullName" SET NOT NULL;
ALTER TABLE "User" DROP COLUMN "firstName";
ALTER TABLE "User" DROP COLUMN "lastName";

-- Product: images[] -> single image (catalog only ever shows one image per product)
ALTER TABLE "Product" ADD COLUMN "image" TEXT;
UPDATE "Product" SET "image" = "images"[1];
ALTER TABLE "Product" ALTER COLUMN "image" SET NOT NULL;
ALTER TABLE "Product" DROP COLUMN "images";
