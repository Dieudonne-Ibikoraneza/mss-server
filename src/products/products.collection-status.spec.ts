import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RoomType, SuitableFor } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { StorageService } from '@/storage/storage.service';
import { OrdersService } from '@/orders/orders.service';
import { TranslationService } from '@/translation/translation.service';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';

describe('product creation in collections', () => {
  const dto: CreateProductDto = {
    name: 'Tile',
    sku: 'TL-001',
    collectionId: 'collection',
    image: 'tile.webp',
    boxCoverageSqm: 1,
    piecesPerBox: 4,
    price: 1000,
    suitableFor: SuitableFor.FLOOR,
    roomTypes: [RoomType.KITCHEN],
  };
  const collection = {
    id: dto.collectionId,
    title: 'Collection',
    size: '50×50cm',
    tileAreaSqm: 0.25,
    isActive: true,
  };
  const product = {
    ...dto,
    id: 'product',
    collection,
    quantityOnHandSqm: 0,
    reservedAreaSqm: 0,
    averageCostPrice: 0,
  };
  const findUnique = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const translateFields = jest.fn();
  const delByPrefix = jest.fn();
  let service: ProductsService;

  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue(collection);
    create.mockResolvedValue(product);
    update.mockResolvedValue(product);
    translateFields.mockResolvedValue({});
    service = new ProductsService(
      {
        collection: { findUnique },
        product: { create, update },
        platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      { delByPrefix } as unknown as RedisService,
      {} as NotificationsService,
      {
        productImageSource: (image: string) => image,
        resolveImageUrl: (image: string) => Promise.resolve(image),
      } as unknown as StorageService,
      {} as OrdersService,
      { translateFields } as unknown as TranslationService,
    );
  });

  it('rejects an inactive collection before translation or product writes', async () => {
    findUnique.mockResolvedValue({ ...collection, isActive: false });
    await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(translateFields).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(delByPrefix).not.toHaveBeenCalled();
  });

  it('rejects a missing collection without creating a product', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows product creation in an active collection', async () => {
    await expect(service.create(dto)).resolves.toMatchObject({ id: 'product' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('allows existing products in inactive collections to be edited', async () => {
    const existing = { ...product, collection: { ...collection, isActive: false } };
    update.mockResolvedValue(existing);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: product.id } as never);
    await expect(service.update(product.id, { price: 1200 })).resolves.toMatchObject({
      id: product.id,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
