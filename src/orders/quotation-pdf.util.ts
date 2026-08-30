import PDFDocument from 'pdfkit';
import type { SuitableFor } from '@prisma/client';

/** Everything the quotation PDF needs — kept as a plain shape rather than a
 * Prisma payload type so this module doesn't need to know the include tree. */
export interface QuotationPdfInput {
  orderNumber: string;
  createdAt: Date;
  currency: string;
  customer: { fullName: string; email: string | null; phone: string | null };
  items: Array<{
    productName: string;
    suitableFor: SuitableFor;
    size: string;
    areaSqm: number;
    totalPrice: number;
  }>;
  subtotal: number;
  transportFee: number | null;
  transportFeeNote: string | null;
  total: number;
  delivery: { address: string; city: string; phone: string } | null;
}

// Palette lifted from the storefront's own quotation screen, so the PDF and
// the in-app view read as the same document.
const NAVY = '#1e3a5f';
const GRAY_LABEL = '#6b7280';
const GRAY_LINE = '#e5e7eb';
const BLACK = '#111827';

/**
 * The business's own MoMo/bank accounts — there is no payment gateway API
 * behind this system, so a customer pays outside it (MoMo code or bank
 * transfer) and then marks the order as paid from the order screen. Mirrors
 * the same constant the storefront shows inline on the quotation card
 * (`paymentInstructions` in `data/order-workflow.ts`) so the PDF and the
 * in-app view never disagree.
 */
const PAYMENT_INSTRUCTIONS = {
  momoCode: '*182*8*1*45231#',
  momoName: 'Magnificat Smart Space Ltd',
  bankName: 'Bank of Kigali',
  bankAccountName: 'Magnificat Smart Space Ltd',
  bankAccountNumber: '00040-11223344-55',
  bankSwift: 'BKIGRWRW',
};

const SUITABLE_FOR_LABEL: Record<SuitableFor, string> = {
  FLOOR: 'Floor Tile',
  WALL: 'Wall Tile',
  BOTH: 'Floor & Wall Tile',
};

const money = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

const LEFT = 46;
const RIGHT = 549;

/**
 * Renders the quotation as a PDF, in-memory, for the customer to view inside
 * the system (3.7 — never emailed, only ever served through the API).
 */
export function renderQuotationPdf(order: QuotationPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 46 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // --- Header: "QUOTATION" / title / tagline, dated top-right -----------
    const headerTop = doc.y;
    doc
      .fontSize(9)
      .fillColor(GRAY_LABEL)
      .font('Helvetica-Bold')
      .text('QUOTATION', LEFT, headerTop, { characterSpacing: 1 });

    doc
      .fontSize(9)
      .fillColor(GRAY_LABEL)
      .font('Helvetica-Bold')
      .text('QUOTATION DATE', 380, headerTop, { width: RIGHT - 380, align: 'right' });
    doc
      .fontSize(10)
      .fillColor(BLACK)
      .font('Helvetica')
      .text(
        order.createdAt.toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'long',
          year: 'numeric',
        }),
        380,
        doc.y,
        { width: RIGHT - 380, align: 'right' },
      );

    doc
      .fontSize(24)
      .fillColor(NAVY)
      .font('Helvetica-Bold')
      .text('Magnificat Smart Space', LEFT, headerTop + 16, { width: 300 });
    doc
      .fontSize(10)
      .fillColor(GRAY_LABEL)
      .font('Helvetica')
      .text('Design smart, live beautifully.', LEFT, doc.y + 2);

    doc.moveDown(1.2);
    rule(doc);
    doc.moveDown(1);

    // --- Customer details ---------------------------------------------------
    label(doc, 'CUSTOMER DETAILS');
    doc.fontSize(11).fillColor(BLACK).font('Helvetica-Bold').text(order.customer.fullName);
    const contactLine = [order.customer.email, order.customer.phone].filter(Boolean).join('  ·  ');
    if (contactLine) {
      doc.fontSize(9.5).fillColor(GRAY_LABEL).font('Helvetica').text(contactLine);
    }

    // --- Delivery details -----------------------------------------------------
    if (order.delivery) {
      doc.moveDown(0.8);
      label(doc, 'DELIVERY DETAILS');
      doc
        .fontSize(10)
        .fillColor(BLACK)
        .font('Helvetica')
        .text(`${order.delivery.address}, ${order.delivery.city}`);
      doc.fontSize(9.5).fillColor(GRAY_LABEL).text(order.delivery.phone);
    }

    doc.moveDown(1.2);
    rule(doc);
    doc.moveDown(1);

    // --- Line items -----------------------------------------------------------
    const colWidth = { qty: 75, unit: 90 };
    const col = { item: LEFT, qty: 261, unit: 346, total: 446 };
    const rowTop = doc.y;
    doc.fontSize(8.5).fillColor(GRAY_LABEL).font('Helvetica-Bold');
    doc.text('ITEM', col.item, rowTop);
    doc.text('QUANTITY', col.qty, rowTop, { width: colWidth.qty, align: 'right' });
    doc.text('UNIT PRICE', col.unit, rowTop, { width: colWidth.unit, align: 'right' });
    doc.text('TOTAL PRICE', col.total, rowTop, { width: RIGHT - col.total, align: 'right' });
    doc.moveDown(0.8);
    rule(doc);
    doc.moveDown(0.6);

    for (const item of order.items) {
      const unitPricePerSqm = item.areaSqm > 0 ? item.totalPrice / item.areaSqm : 0;
      const y = doc.y;
      doc
        .fontSize(10.5)
        .fillColor(BLACK)
        .font('Helvetica-Bold')
        .text(item.productName, col.item, y, {
          width: col.qty - col.item - 12,
        });
      doc
        .fontSize(9)
        .fillColor(GRAY_LABEL)
        .font('Helvetica')
        .text(`${SUITABLE_FOR_LABEL[item.suitableFor]} · ${item.size}`, col.item, doc.y);

      doc
        .fontSize(10)
        .fillColor(NAVY)
        .font('Helvetica')
        .text(`${item.areaSqm.toLocaleString('en-US')} sqm`, col.qty, y, {
          width: colWidth.qty,
          align: 'right',
        });
      doc.text(money(unitPricePerSqm, order.currency), col.unit, y, {
        width: colWidth.unit,
        align: 'right',
      });
      doc
        .font('Helvetica-Bold')
        .fillColor(BLACK)
        .text(money(item.totalPrice, order.currency), col.total, y, {
          width: RIGHT - col.total,
          align: 'right',
        });

      doc.moveDown(1.1);
    }

    rule(doc);
    doc.moveDown(1);

    // --- Totals -----------------------------------------------------------
    totalsLine(doc, 'Subtotal', money(order.subtotal, order.currency), false);
    doc.moveDown(0.4);
    totalsLine(
      doc,
      'Transport',
      order.transportFee === null
        ? 'Not yet costed'
        : order.transportFee === 0
          ? 'Free'
          : money(order.transportFee, order.currency),
      false,
    );
    if (order.transportFeeNote) {
      doc
        .fontSize(8)
        .fillColor(GRAY_LABEL)
        .font('Helvetica')
        .text(order.transportFeeNote, LEFT, doc.y, { width: RIGHT - LEFT, align: 'right' });
    }
    doc.moveDown(0.7);
    totalsLine(doc, 'Total quotation', money(order.total, order.currency), true);

    doc.moveDown(1.4);
    rule(doc);
    doc.moveDown(1);

    // --- Payment details ---------------------------------------------------
    label(doc, 'PAYMENT DETAILS');
    doc
      .fontSize(9.5)
      .fillColor(GRAY_LABEL)
      .font('Helvetica')
      .text('Pay the total above via either option, then mark this order as paid from the order screen.');
    doc.moveDown(0.6);

    doc.fontSize(10).fillColor(BLACK).font('Helvetica-Bold').text('MoMo Pay');
    doc
      .fontSize(10.5)
      .fillColor(NAVY)
      .font('Helvetica-Bold')
      .text(PAYMENT_INSTRUCTIONS.momoCode);
    doc
      .fontSize(9)
      .fillColor(GRAY_LABEL)
      .font('Helvetica')
      .text(PAYMENT_INSTRUCTIONS.momoName);

    doc.moveDown(0.6);
    doc.fontSize(10).fillColor(BLACK).font('Helvetica-Bold').text('Bank transfer');
    doc
      .fontSize(10)
      .fillColor(BLACK)
      .font('Helvetica')
      .text(`${PAYMENT_INSTRUCTIONS.bankName} — ${PAYMENT_INSTRUCTIONS.bankAccountNumber}`);
    doc
      .fontSize(9)
      .fillColor(GRAY_LABEL)
      .font('Helvetica')
      .text(`${PAYMENT_INSTRUCTIONS.bankAccountName} · SWIFT ${PAYMENT_INSTRUCTIONS.bankSwift}`);

    doc.moveDown(1.4);
    doc
      .fontSize(8)
      .fillColor(GRAY_LABEL)
      .font('Helvetica')
      .text(
        `Order ${order.orderNumber} — generated for viewing inside Magnificat Smart Space only. ` +
          'Confirm payment from the order screen once you have reviewed it.',
        LEFT,
        doc.y,
        { width: RIGHT - LEFT },
      );

    doc.end();
  });
}

function rule(doc: PDFKit.PDFDocument) {
  doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(GRAY_LINE).lineWidth(1).stroke();
}

function label(doc: PDFKit.PDFDocument, text: string) {
  doc
    .fontSize(8.5)
    .fillColor(GRAY_LABEL)
    .font('Helvetica-Bold')
    .text(text, { characterSpacing: 1 });
  doc.moveDown(0.3);
}

function totalsLine(doc: PDFKit.PDFDocument, rowLabel: string, value: string, emphasize: boolean) {
  const y = doc.y;
  doc
    .fontSize(emphasize ? 12 : 10)
    .fillColor(emphasize ? NAVY : GRAY_LABEL)
    .font('Helvetica-Bold')
    .text(rowLabel, LEFT, y);
  doc
    .fontSize(emphasize ? 13 : 10.5)
    .fillColor(emphasize ? NAVY : BLACK)
    .font('Helvetica-Bold')
    .text(value, LEFT, y, { width: RIGHT - LEFT, align: 'right' });
}
