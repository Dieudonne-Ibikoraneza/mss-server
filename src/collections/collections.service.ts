import { bestEffort } from '@/redis/best-effort';
import { Injectable } from '@nestjs/common';
import { forbidden, notFound } from '@/common/errors/app-error';
import { Language, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { canSeeExactStock, canSeeFullInventory } from '@/common/utils/stock-status';
import { paginate } from '@/common/dto/pagination.dto';
import { slugify } from '@/common/utils/slugify';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import {
  CollectionCatalogStatus,
  CollectionSort,
  QueryCollectionsDto,
} from './dto/query-collections.dto';
import { COLLECTION_IMAGES_BUCKET, StorageService } from '@/storage/storage.service';
import { TranslationService } from '@/translation/translation.service';

const LIST_CACHE_PREFIX = 'cache:collections:list:';
// v2: entries written before exact stock and cost were stripped (v1) held full rows and must never be read again.
const DETAIL_CACHE_PREFIX = 'cache:collections:detail:v2:';
/** Collections rarely change, so it's safe to cache them longer than most reads. */
const CACHE_TTL_SECONDS = 300;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly translation: TranslationService,
  ) {}

  async findAll(query: QueryCollectionsDto, viewerRole?: Role) {
    const catalogStatus = query.catalogStatus ?? CollectionCatalogStatus.ACTIVE;
    if (
      catalogStatus !== CollectionCatalogStatus.ACTIVE &&
      viewerRole !== Role.ADMIN &&
      viewerRole !== Role.STOCK_MANAGER
    ) {
      throw forbidden(
        'collections.inactiveCatalogRestricted',
        'Inactive collections are available only to admins and stock managers.',
      );
    }
    const cacheKey = `${LIST_CACHE_PREFIX}page=${query.page}:limit=${query.limit}:search=${query.search ?? ''}:size=${query.size ?? ''}:sort=${query.sort ?? ''}:catalogStatus=${catalogStatus}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const where = {
      isActive:
        catalogStatus === CollectionCatalogStatus.ALL
          ? undefined
          : catalogStatus === CollectionCatalogStatus.ACTIVE,
      size: query.size,
      title: query.search ? { contains: query.search, mode: 'insensitive' as const } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.collection.findMany({
        where,
        include: { _count: { select: { products: { where: { isActive: true } } } } },
        orderBy: { createdAt: query.sort === CollectionSort.OLDEST ? 'asc' : 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.collection.count({ where }),
    ]);

    const result = paginate(await this.withImageUrls(items), total, query.page, query.limit);
    await this.redis.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  /**
   * The collection with its active products. Exact stock, reservations and
   * cost are staff-only (doc 3.2) and this route is public, so what is cached
   * and what anonymous callers and customers receive has those fields removed;
   * sales get physical quantities only; the full inventory view is restricted
   * to admin/stock/analyst roles. Staff views are never cached here.
   */
  async findOne(id: string, viewerRole?: Role) {
    const staffView = canSeeExactStock(viewerRole);
    const cacheKey = `${DETAIL_CACHE_PREFIX}${id}`;
    if (!staffView) {
      const cached = await this.redis.get<typeof result>(cacheKey);
      if (cached) return cached;
    }

    const collection = await this.prisma.collection.findUnique({
      where: { id },
      include: { products: { where: { isActive: true } } },
    });
    if (!collection) throw notFound('collections.notFound', 'Collection not found.');

    const products = canSeeFullInventory(viewerRole)
      ? collection.products
      : collection.products.map((product) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { quantityOnHandSqm, reservedAreaSqm, averageCostPrice, ...customerSafe } = product;
          return {
            ...customerSafe,
            ...(staffView ? { quantityOnHandSqm: Number(quantityOnHandSqm) } : {}),
          };
        });
    const result = { ...collection, products, image: await this.withImageUrl(collection.image) };
    if (!staffView) await this.redis.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  async create(dto: CreateCollectionDto) {
    const translated = await this.translation.translateFields(
      { title: dto.title, description: dto.description },
      Language.EN,
      Language.RW,
    );
    const collection = await this.prisma.collection.create({
      data: {
        ...dto,
        slug: slugify(dto.title),
        titleRw: translated.title ?? null,
        descriptionRw: translated.description ?? null,
      },
    });
    await bestEffort('clear the collection list cache', () =>
      this.redis.delByPrefix(LIST_CACHE_PREFIX),
    );
    return collection;
  }

  async update(id: string, dto: UpdateCollectionDto) {
    await this.assertExists(id);

    // `title`/`description` are the always-English columns; `titleRw`/
    // `descriptionRw` the always-Kinyarwanda ones. The edit dialog sends
    // whichever pair matches the admin UI's current language — sending
    // `titleRw`/`descriptionRw` (and not `title`/`description`) means this
    // edit was authored in Kinyarwanda, so it's the *English* columns that
    // get regenerated here, not the usual other way round.
    const { title, description, titleRw, descriptionRw, ...rest } = dto;
    const editedInRw =
      (titleRw !== undefined || descriptionRw !== undefined) &&
      title === undefined &&
      description === undefined;

    const translated = editedInRw
      ? await this.translation.translateFields(
          { title: titleRw, description: descriptionRw },
          Language.RW,
          Language.EN,
        )
      : await this.translation.translateFields({ title, description }, Language.EN, Language.RW);

    const finalTitle = editedInRw ? translated.title : title;
    const finalDescription = editedInRw ? translated.description : description;
    const finalTitleRw = editedInRw ? titleRw : translated.title;
    const finalDescriptionRw = editedInRw ? descriptionRw : translated.description;

    const collection = await this.prisma.collection.update({
      where: { id },
      data: {
        ...rest,
        title: finalTitle,
        description: finalDescription,
        slug: finalTitle ? slugify(finalTitle) : undefined,
        titleRw: finalTitleRw,
        descriptionRw: finalDescriptionRw,
      },
    });
    await bestEffort('clear the collection cache', () =>
      Promise.all([
        this.redis.delByPrefix(LIST_CACHE_PREFIX),
        this.redis.del(`${DETAIL_CACHE_PREFIX}${id}`),
      ]),
    );
    return collection;
  }

  async remove(id: string) {
    await this.assertExists(id);
    await this.prisma.collection.update({ where: { id }, data: { isActive: false } });
    await bestEffort('clear the collection cache', () =>
      Promise.all([
        this.redis.delByPrefix(LIST_CACHE_PREFIX),
        this.redis.del(`${DETAIL_CACHE_PREFIX}${id}`),
      ]),
    );
  }

  private async withImageUrls<T extends { image: string | null }>(collections: T[]) {
    return Promise.all(
      collections.map(async (collection) => ({
        ...collection,
        image: await this.withImageUrl(collection.image),
      })),
    );
  }

  private async withImageUrl(image: string | null) {
    if (!image) return image;
    // Recovers the bare path if `image` was ever saved as one of our own
    // (possibly expired) signed URLs instead of its bare path — see
    // `ProductsService`'s identical guard for why this needs to self-heal
    // rather than just trust whatever's stored.
    const signedPathMatch = /\/storage\/v1\/object\/sign\/[^/]+\/(.+?)(?:\?|$)/.exec(image);
    if (signedPathMatch) {
      return this.storage.getSignedUrl(
        decodeURIComponent(signedPathMatch[1]),
        COLLECTION_IMAGES_BUCKET,
      );
    }
    if (/^https?:\/\//i.test(image)) return image;
    return this.storage.getSignedUrl(image, COLLECTION_IMAGES_BUCKET);
  }

  private async assertExists(id: string) {
    const collection = await this.prisma.collection.findUnique({ where: { id } });
    if (!collection) throw notFound('collections.notFound', 'Collection not found.');
  }
}
