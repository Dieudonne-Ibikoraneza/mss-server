import { Prisma, PrismaClient, Language, Role, RoomType, SuitableFor } from '@prisma/client';

const prisma = new PrismaClient();

/** Shared minimal shell so every transactional email looks consistent. */
const emailShell = (bodyHtml: string) => `
<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1f2937;">
  <p style="font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #b8860b; font-weight: 600; margin: 0 0 20px;">Magnificat Smart Space</p>
  ${bodyHtml}
  <p style="margin-top: 32px; font-size: 12px; color: #9ca3af;">This is an automated message — please don't reply directly to this email.</p>
</div>
`.trim();

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: 'admin@magnificatsmartspace.rw' },
    update: {},
    create: {
      fullName: 'Magnificat Admin',
      email: 'admin@magnificatsmartspace.rw',
      phone: '+250780000000',
      role: Role.ADMIN,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    },
  });
  console.log(`Admin user ready: ${admin.email} — sign in via OTP (POST /auth/otp/request).`);

  // Titles, copy and imagery match the storefront's collection cards.
  const collections = await Promise.all(
    [
      {
        title: '50×50cm Floor Tiles',
        slug: 'premium-slabs',
        size: '50×50cm',
        tileAreaSqm: 0.25,
        description:
          'Grand format tiles for seamless, luxurious open spaces. Ideal for statement walls and expansive floors, this collection delivers timeless elegance, refined textures, and a sophisticated finish for modern interiors.',
        image:
          'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=900&q=85',
      },
      {
        title: '25×40cm Wall Tiles',
        slug: 'wood-effect',
        size: '25×40cm',
        tileAreaSqm: 0.1,
        description:
          'Versatile rectangular tiles designed for bathrooms, kitchens, and feature walls. Their warm wood-inspired finish brings natural character, lasting comfort, and an inviting contemporary feel to every interior.',
        image:
          'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=900&q=85',
      },
      {
        title: '30×30cm Mosaic Tiles',
        slug: 'large-floor',
        size: '30×30cm',
        tileAreaSqm: 0.09,
        description:
          'Intricate mosaic tiles created for high-grip shower floors, decorative borders, and expressive focal points. Detailed patterns and durable surfaces make this collection both practical and visually distinctive.',
        image:
          'https://images.unsplash.com/photo-1600607688969-a5bfcd646154?auto=format&fit=crop&w=900&q=85',
      },
      {
        title: '40×40cm Standard Tiles',
        slug: 'standard-floor',
        size: '40×40cm',
        tileAreaSqm: 0.16,
        description:
          'Classic square tiles for bathrooms, kitchens, living rooms, and floors. Balanced proportions, dependable performance, and timeless styling make this collection an effortless choice for everyday spaces.',
        image:
          'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=900&q=85',
      },
      {
        title: '60×60cm Large Format',
        slug: 'subway-wall',
        size: '60×60cm',
        tileAreaSqm: 0.36,
        description:
          'Expansive square tiles designed to minimize grout lines and create a calm, continuous surface. Their clean format and refined finish are ideal for modern interiors, open-plan floors, and statement walls.',
        image:
          'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=900&q=85',
      },
      {
        title: '20×40cm Wall Tiles',
        slug: 'mosaics',
        size: '20×40cm',
        tileAreaSqm: 0.08,
        description:
          'Elegant rectangular tiles for striking bathroom walls and kitchen backsplashes. The collection combines refined proportions, expressive surface detail, and dependable durability for polished contemporary spaces.',
        image:
          'https://images.unsplash.com/photo-1615529162924-f8605388461d?auto=format&fit=crop&w=900&q=85',
      },
    ].map((c) =>
      prisma.collection.upsert({
        where: { slug: c.slug },
        // Copy and imagery are safe to refresh on every seed run; stock and
        // pricing are never touched here.
        update: { title: c.title, description: c.description, image: c.image },
        create: c,
      }),
    ),
  );

  const [premiumSlabs, woodEffect] = collections;

  await prisma.product.upsert({
    where: { sku: 'MSS-CAL-GOLD-5050' },
    update: {},
    create: {
      sku: 'MSS-CAL-GOLD-5050',
      name: 'Calacatta Gold Polished',
      slug: 'calacatta-gold-polished-5050',
      collectionId: premiumSlabs.id,
      boxCoverageSqm: 1.75,
      piecesPerBox: 7,
      price: 22000,
      image:
        'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=900&q=85',
      description:
        'Pre-cut polished granite step tiles with a bullnose edge. Ideal for creating stunning spaces.',
      suitableFor: SuitableFor.BOTH,
      roomTypes: [RoomType.LIVING_ROOM, RoomType.KITCHEN],
      // Cost ~14,000/box (7 pcs) → 2,000/piece average cost, vs. 22,000/box selling price.
      inventory: {
        create: { quantityOnHand: 500, lowStockThreshold: 50, averageCostPrice: 2000 },
      },
    },
  });

  await prisma.product.upsert({
    where: { sku: 'MSS-CAL-GOLD-2540' },
    update: {},
    create: {
      sku: 'MSS-CAL-GOLD-2540',
      name: 'Oak Herringbone Parquet',
      slug: 'oak-herringbone-parquet-2540',
      collectionId: woodEffect.id,
      boxCoverageSqm: 1.5,
      piecesPerBox: 15,
      price: 15000,
      image:
        'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=900&q=85',
      description:
        'Warm wood-inspired finish, versatile rectangular tiles for bathrooms, kitchens and feature walls.',
      suitableFor: SuitableFor.FLOOR,
      roomTypes: [RoomType.LIVING_ROOM, RoomType.OUTDOOR],
      // Cost ~9,500/box (15 pcs) → 633.33/piece average cost, vs. 15,000/box selling price.
      inventory: {
        create: { quantityOnHand: 15, lowStockThreshold: 20, averageCostPrice: 633.33 },
      },
    },
  });

  // A second 25×40cm product with different box packaging (same tile size/area, different piecesPerBox).
  await prisma.product.upsert({
    where: { sku: 'MSS-OAK-2540-16PC' },
    update: {},
    create: {
      sku: 'MSS-OAK-2540-16PC',
      name: 'Oak Herringbone Parquet (16pc box)',
      slug: 'oak-herringbone-parquet-2540-16pc',
      collectionId: woodEffect.id,
      boxCoverageSqm: 1.6,
      piecesPerBox: 16,
      price: 15400,
      image:
        'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=900&q=85',
      description: 'Same 25×40cm size as the standard pack, sourced in 16-piece boxes.',
      suitableFor: SuitableFor.FLOOR,
      roomTypes: [RoomType.LIVING_ROOM, RoomType.OUTDOOR],
      // Cost ~9,800/box (16 pcs) → 612.5/piece average cost, vs. 15,400/box selling price.
      inventory: {
        create: { quantityOnHand: 40, lowStockThreshold: 20, averageCostPrice: 612.5 },
      },
    },
  });

  await Promise.all(
    [
      { type: RoomType.LIVING_ROOM, name: 'Living Room (Saloon)' },
      { type: RoomType.BATHROOM, name: 'Bathroom' },
      { type: RoomType.KITCHEN, name: 'Kitchen' },
      { type: RoomType.BEDROOM, name: 'Bedroom' },
      { type: RoomType.BALCONY, name: 'Balcony' },
      { type: RoomType.STAIRS, name: 'Stairs' },
      { type: RoomType.GATES, name: 'Gates' },
    ].map((room) =>
      prisma.room.findFirst({ where: { type: room.type } }).then((existing) =>
        existing
          ? existing
          : prisma.room.create({
              data: {
                type: room.type,
                name: room.name,
                modelUrl: `/models/rooms/${room.type.toLowerCase()}.glb`,
              },
            }),
      ),
    ),
  );

  await prisma.knowledgeBaseEntry.upsert({
    where: { id: 'seed-kb-1' },
    update: {},
    create: {
      id: 'seed-kb-1',
      question: 'What tile size is best for a small bathroom?',
      answer:
        'For small bathrooms, larger format tiles (40×40cm or bigger) with minimal grout lines make the space feel bigger. Pair with a light, polished finish.',
      tags: ['bathroom', 'size'],
    },
  });

  // --- Email templates ---------------------------------------------------
  // Keys must match EMAIL_TEMPLATE_KEYS in src/notifications/notifications.service.ts.
  const emailTemplates = [
    {
      key: 'OTP_VERIFICATION',
      language: Language.EN,
      subject: 'Your Magnificat Smart Space verification code',
      bodyText:
        "Your verification code is {{code}}.\nIt expires in {{expiresInMinutes}} minutes. Don't share it with anyone.",
      bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 20px;">Your verification code is:</p>
        <p style="font-size: 32px; font-weight: 700; letter-spacing: 0.15em; margin: 0 0 20px; color: #111827;">{{code}}</p>
        <p style="font-size: 14px; color: #4b5563; margin: 0;">It expires in {{expiresInMinutes}} minutes. Don't share it with anyone.</p>
      `),
    },
    {
      key: 'OTP_VERIFICATION',
      language: Language.RW,
      subject: 'Umubare wawe wo kwemeza kuri Magnificat Smart Space',
      bodyText:
        "Umubare wawe wo kwemeza ni {{code}}.\nUzarangira mu minota {{expiresInMinutes}}. Ntuwusangire n'undi muntu.",
      bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 20px;">Umubare wawe wo kwemeza ni:</p>
        <p style="font-size: 32px; font-weight: 700; letter-spacing: 0.15em; margin: 0 0 20px; color: #111827;">{{code}}</p>
        <p style="font-size: 14px; color: #4b5563; margin: 0;">Uzarangira mu minota {{expiresInMinutes}}. Ntuwusangire n'undi muntu.</p>
      `),
    },
    {
      key: 'STAFF_ACCOUNT_CREATED',
      language: Language.EN,
      subject: 'Your Magnificat Smart Space staff account is ready',
      bodyText:
        'Hi {{fullName}},\n\nAn admin has created a {{role}} account for you at Magnificat Smart Space.\n\n' +
        'Sign in anytime using this email address ({{loginEmail}}) — we\'ll send you a one-time code by email. ' +
        "There's no password to remember.",
      bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 16px;">Hi {{fullName}},</p>
        <p style="font-size: 15px; margin: 0 0 16px;">An admin has created a <strong>{{role}}</strong> account for you at Magnificat Smart Space.</p>
        <p style="font-size: 15px; margin: 0 0 16px;">Sign in anytime using this email address (<strong>{{loginEmail}}</strong>) — we'll send you a one-time code by email. There's no password to remember.</p>
      `),
    },
    {
      key: 'LOW_STOCK_ALERT',
      language: Language.EN,
      subject: 'Low stock: {{itemCount}} product(s) need restocking',
      bodyText:
        'Hi {{fullName}},\n\nThe following products have fallen to or below their low-stock threshold:\n\n' +
        '{{items}}\n\nOpen the stock dashboard to review and restock them.',
      bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 16px;">Hi {{fullName}},</p>
        <p style="font-size: 15px; margin: 0 0 16px;">The following products have fallen to or below their low-stock threshold:</p>
        <p style="font-size: 14px; color: #4b5563; margin: 0 0 16px; line-height: 1.7;">{{items}}</p>
        <p style="font-size: 15px; margin: 0;">Open the stock dashboard to review and restock them.</p>
      `),
    },
    {
      key: 'LOW_STOCK_ALERT',
      language: Language.RW,
      subject: 'Ububiko buke: ibicuruzwa {{itemCount}} bikeneye kongerwamo',
      bodyText:
        'Muraho {{fullName}},\n\nIbi bicuruzwa bikurikira bigeze cyangwa biri munsi y\'urugero rwo hasi rw\'ububiko:\n\n' +
        '{{items}}\n\nFungura ububiko kugira ngo ubisuzume kandi wongeremo.',
      bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 16px;">Muraho {{fullName}},</p>
        <p style="font-size: 15px; margin: 0 0 16px;">Ibi bicuruzwa bikurikira bigeze cyangwa biri munsi y'urugero rwo hasi rw'ububiko:</p>
        <p style="font-size: 14px; color: #4b5563; margin: 0 0 16px; line-height: 1.7;">{{items}}</p>
        <p style="font-size: 15px; margin: 0;">Fungura ububiko kugira ngo ubisuzume kandi wongeremo.</p>
      `),
    },
    {
      key: 'STAFF_ACCOUNT_CREATED',
      language: Language.RW,
      subject: "Konti yawe y'abakozi kuri Magnificat Smart Space iratunganye",
      bodyText:
        'Muraho {{fullName}},\n\nUmuyobozi yabashije gukorera konti ya {{role}} kuri Magnificat Smart Space.\n\n' +
        "Winjira igihe cyose ukoresheje iyi email ({{loginEmail}}) — tuzakohereza umubare wo kwemeza kuri email. Nta ijambo ry'ibanga rikenewe.",
      bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 16px;">Muraho {{fullName}},</p>
        <p style="font-size: 15px; margin: 0 0 16px;">Umuyobozi yabashije gukorera konti ya <strong>{{role}}</strong> kuri Magnificat Smart Space.</p>
        <p style="font-size: 15px; margin: 0 0 16px;">Winjira igihe cyose ukoresheje iyi email (<strong>{{loginEmail}}</strong>) — tuzakohereza umubare wo kwemeza kuri email. Nta ijambo ry'ibanga rikenewe.</p>
      `),
    },
  ];

  await Promise.all(
    emailTemplates.map((t) =>
      prisma.emailTemplate.upsert({
        where: { key_language: { key: t.key, language: t.language } },
        update: { subject: t.subject, bodyText: t.bodyText, bodyHtml: t.bodyHtml, isActive: true },
        create: t,
      }),
    ),
  );
  console.log(`Email templates ready: ${emailTemplates.length} rows.`);

  // --- Platform settings --------------------------------------------------
  // Keys must match SETTINGS_DEFAULTS in src/settings/settings.defaults.ts.
  const platformSettings: Record<string, unknown> = {
    'platform.name': 'Magnificat Smart Space',
    'platform.defaultCurrency': 'RWF',
    'platform.defaultLanguage': 'EN',
    'platform.version': '1.0.0',
    'notifications.lowStockAlerts': true,
    'notifications.orderUpdates': true,
    'notifications.systemNotifications': true,
    'payment.momoCode': '*182*8*1*45231#',
    'payment.momoName': 'Magnificat Smart Space Ltd',
    'payment.bankName': 'Bank of Kigali',
    'payment.bankAccountName': 'Magnificat Smart Space Ltd',
    'payment.bankAccountNumber': '00040-11223344-55',
    'payment.bankSwift': 'BKIGRWRW',
    'support.phone': '+250 788 300 400',
    'support.email': 'support@magnificatsmartspace.rw',
    'support.whatsapp': '+250 788 300 400',
    'calculator.defaultWastagePercent': 10,
  };

  await Promise.all(
    Object.entries(platformSettings).map(([key, value]) =>
      prisma.platformSetting.upsert({
        where: { key },
        update: {},
        create: { key, value: value as Prisma.InputJsonValue },
      }),
    ),
  );
  console.log(`Platform settings ready: ${Object.keys(platformSettings).length} rows.`);

  // --- AI customer-profiling questions (doc 3.6) ---------------------------
  // A question with a roomType is conditional: only asked for that room type.
  const profilingQuestions: {
    text: string;
    isRequired: boolean;
    roomType: RoomType | null;
  }[] = [
    { text: 'What is your primary goal for using this space today?', isRequired: true, roomType: null },
    { text: 'Which room are you designing?', isRequired: true, roomType: null },
    { text: 'What is the approximate size of the space?', isRequired: true, roomType: null },
    { text: 'What is the primary wall paint color?', isRequired: true, roomType: null },
    { text: 'What is the dominant color of your large furniture?', isRequired: false, roomType: RoomType.LIVING_ROOM },
    { text: 'What style are the interior doors?', isRequired: false, roomType: RoomType.LIVING_ROOM },
    { text: 'Are the tables predominantly wooden or glass?', isRequired: false, roomType: RoomType.LIVING_ROOM },
    { text: 'What is the style of your window curtains or blinds?', isRequired: false, roomType: RoomType.LIVING_ROOM },
    { text: 'What material are the accent chairs?', isRequired: false, roomType: RoomType.LIVING_ROOM },
  ];

  for (const [position, question] of profilingQuestions.entries()) {
    const existing = await prisma.profilingQuestion.findFirst({
      where: { text: question.text, language: Language.EN },
    });
    if (existing) continue;
    await prisma.profilingQuestion.create({ data: { ...question, position } });
  }
  console.log(`Profiling questions ready: ${profilingQuestions.length} rows.`);

  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
