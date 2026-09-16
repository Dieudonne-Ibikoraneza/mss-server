-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "descriptionRw" TEXT,
ADD COLUMN     "titleRw" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "descriptionRw" TEXT,
ADD COLUMN     "nameRw" TEXT;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "descriptionRw" TEXT,
ADD COLUMN     "nameRw" TEXT;
