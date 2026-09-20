import { Injectable } from '@nestjs/common';
import { notFound } from '@/common/errors/app-error';
import { OrderMessageAuthor, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { decodeCursor, encodeCursor } from '@/common/utils/cursor';
import { ListNegotiationInboxDto } from './dto/list-negotiation-inbox.dto';

export type NegotiationThreadKind = 'order' | 'cart';

/** One row of the staff inbox: everything the list needs, and nothing of the thread beyond its newest message. */
export interface NegotiationInboxThread {
  kind: NegotiationThreadKind;
  id: string;
  /** Order threads only. */
  orderNumber: string | null;
  customer: { id: string; fullName: string; email: string | null };
  messageCount: number;
  lastMessageAt: Date;
  lastMessage: {
    id: string;
    author: OrderMessageAuthor;
    senderId: string | null;
    body: string;
    createdAt: Date;
  };
  /** The newest message wasn't written by staff — the customer (or the system) is waiting on someone. */
  awaitingReply: boolean;
}

interface InboxRow {
  kind: NegotiationThreadKind;
  id: string;
  order_number: string | null;
  customer_id: string;
  full_name: string;
  email: string | null;
  message_count: number;
  last_at: Date;
  msg_id: string;
  msg_author: OrderMessageAuthor;
  msg_sender: string | null;
  msg_body: string;
}

/** Escapes `%`, `_` and the escape character itself for an `ILIKE ... ESCAPE '!'` pattern. */
const likePattern = (term: string) => `%${term.replace(/[!%_]/g, (char) => `!${char}`)}%`;

/**
 * The staff negotiation inbox as ONE query. It used to be assembled by the
 * client: list 100 orders, then fetch every order's messages one by one (up
 * to 102 requests a load, growing with the number of orders). Here the
 * database groups each thread's messages once, keeps only the requested
 * page, and only then looks up that page's newest message — so cost follows
 * the page size, and threads are ordered by their latest activity across
 * both kinds (order threads and pre-order cart threads) with a stable keyset
 * cursor.
 *
 * Messages written in one transaction (a shortage's SYSTEM message and the
 * customer's own, say) share an identical `createdAt` — Postgres `now()` is
 * per transaction — so "the newest message" needs a tie-break. It is the
 * row inserted last (`ctid`, physical insertion order), which is also the one
 * the thread view shows at the bottom; comparing the random UUIDs instead
 * would pick an arbitrary one of the tied messages for the preview.
 */
@Injectable()
export class NegotiationInboxService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListNegotiationInboxDto) {
    const limit = query.limit ?? 25;
    const search = query.search?.trim();
    const conditions: Prisma.Sql[] = [];

    if (search) {
      const pattern = likePattern(search);
      conditions.push(
        Prisma.sql`(u."fullName" ILIKE ${pattern} ESCAPE '!' OR u."email" ILIKE ${pattern} ESCAPE '!' OR t.order_number ILIKE ${pattern} ESCAPE '!')`,
      );
    }
    if (query.cursor) {
      const { at, id } = decodeCursor(query.cursor);
      conditions.push(Prisma.sql`(t.last_at, t.id) < (${at}, ${id})`);
    }

    const rows = await this.fetch(conditions, limit + 1);
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.toThread(row));
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: hasMore && last ? encodeCursor(last.lastMessageAt, last.id) : null,
    };
  }

  /** One thread's inbox row — how a live "thread updated" event refreshes a single line instead of the whole list. */
  async summary(kind: NegotiationThreadKind, id: string) {
    const rows = await this.fetch([Prisma.sql`t.kind = ${kind}`, Prisma.sql`t.id = ${id}`], 1);
    if (rows.length === 0)
      throw notFound('negotiationInbox.threadNotFound', 'Negotiation thread not found.');
    return this.toThread(rows[0]);
  }

  private fetch(conditions: Prisma.Sql[], take: number) {
    const where = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
    return this.prisma.$queryRaw<InboxRow[]>(Prisma.sql`
      WITH order_threads AS (
        SELECT m."orderId" AS id, max(m."createdAt") AS last_at, count(*)::int AS message_count
        FROM "OrderMessage" m
        GROUP BY m."orderId"
      ), cart_threads AS (
        SELECT m."negotiationId" AS id, max(m."createdAt") AS last_at, count(*)::int AS message_count
        FROM "CartNegotiationMessage" m
        GROUP BY m."negotiationId"
      ), threads AS (
        SELECT 'order'::text AS kind, ot.id, ot.last_at, ot.message_count,
               o."orderNumber" AS order_number, o."customerId" AS customer_id
        FROM order_threads ot
        JOIN "Order" o ON o."id" = ot.id
        UNION ALL
        SELECT 'cart'::text, ct.id, ct.last_at, ct.message_count,
               NULL::text, n."customerId"
        FROM cart_threads ct
        JOIN "CartNegotiation" n ON n."id" = ct.id
      ), page AS (
        SELECT t.kind, t.id, t.last_at, t.message_count, t.order_number, t.customer_id,
               u."fullName" AS full_name, u."email" AS email
        FROM threads t
        JOIN "User" u ON u."id" = t.customer_id
        ${where}
        ORDER BY t.last_at DESC, t.id DESC
        LIMIT ${take}
      )
      SELECT p.kind, p.id, p.last_at, p.message_count, p.order_number, p.customer_id, p.full_name, p.email,
             COALESCE(om.id, cm.id) AS msg_id,
             COALESCE(om.author, cm.author)::text AS msg_author,
             COALESCE(om."senderId", cm."senderId") AS msg_sender,
             COALESCE(om.body, cm.body) AS msg_body
      FROM page p
      LEFT JOIN LATERAL (
        SELECT m."id", m."author", m."senderId", m."body"
        FROM "OrderMessage" m
        WHERE p.kind = 'order' AND m."orderId" = p.id
        ORDER BY m."createdAt" DESC, m.ctid DESC
        LIMIT 1
      ) om ON true
      LEFT JOIN LATERAL (
        SELECT m."id", m."author", m."senderId", m."body"
        FROM "CartNegotiationMessage" m
        WHERE p.kind = 'cart' AND m."negotiationId" = p.id
        ORDER BY m."createdAt" DESC, m.ctid DESC
        LIMIT 1
      ) cm ON true
      ORDER BY p.last_at DESC, p.id DESC
    `);
  }

  private toThread(row: InboxRow): NegotiationInboxThread {
    return {
      kind: row.kind,
      id: row.id,
      orderNumber: row.order_number,
      customer: { id: row.customer_id, fullName: row.full_name, email: row.email },
      messageCount: row.message_count,
      lastMessageAt: row.last_at,
      lastMessage: {
        id: row.msg_id,
        author: row.msg_author,
        senderId: row.msg_sender,
        body: row.msg_body,
        createdAt: row.last_at,
      },
      awaitingReply: row.msg_author !== OrderMessageAuthor.STAFF,
    };
  }
}
