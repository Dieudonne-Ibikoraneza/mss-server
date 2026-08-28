import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { paginate } from '@/common/dto/pagination.dto';
import { slugify } from '@/common/utils/slugify';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { QueryCollectionsDto } from './dto/query-collections.dto';

const LIST_CACHE_PREFIX = 'cache:collections:list:';
const DETAIL_CACHE_PREFIX = 'cache:collections:detail:';
/** Collections rarely change, so it's safe to cache them longer than most reads. */
const CACHE_TTL_SECONDS = 300;

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findAll(query: QueryCollectionsDto) {
    const cacheKey = `${LIST_CACHE_PREFIX}page=${query.page}:limit=${query.limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const where = { isActive: true };
    const [items, total] = await Promise.all([
      this.prisma.collection.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.collection.count({ where }),
    ]);

    const result = paginate(items, total, query.page, query.limit);
    await this.redis.set(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  }

  async findOne(id: string) {
    const cacheKey = `${DETAIL_CACHE_PREFIX}${id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const collection = await this.prisma.collection.findUnique({
      where: { id },
      include: { products: { where: { isActive: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found.');

    await this.redis.set(cacheKey, collection, CACHE_TTL_SECONDS);
    return collection;
  }

  async create(dto: CreateCollectionDto) {
    const collection = await this.prisma.collection.create({
      data: { ...dto, slug: slugify(dto.title) },
    });
    await this.redis.delByPrefix(LIST_CACHE_PREFIX);
    return collection;
  }

  async update(id: string, dto: UpdateCollectionDto) {
    await this.assertExists(id);
    const collection = await this.prisma.collection.update({
      where: { id },
      data: { ...dto, slug: dto.title ? slugify(dto.title) : undefined },
    });
    await Promise.all([
      this.redis.delByPrefix(LIST_CACHE_PREFIX),
      this.redis.del(`${DETAIL_CACHE_PREFIX}${id}`),
    ]);
    return collection;
  }

  async remove(id: string) {
    await this.assertExists(id);
    await this.prisma.collection.update({ where: { id }, data: { isActive: false } });
    await Promise.all([
      this.redis.delByPrefix(LIST_CACHE_PREFIX),
      this.redis.del(`${DETAIL_CACHE_PREFIX}${id}`),
    ]);
  }

  private async assertExists(id: string) {
    const collection = await this.prisma.collection.findUnique({ where: { id } });
    if (!collection) throw new NotFoundException('Collection not found.');
  }
}
