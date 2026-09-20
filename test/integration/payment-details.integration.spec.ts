import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from '../../src/settings/settings.service';
import {
  createActors,
  createProduct,
  makeOrders,
  placeOrder,
  prisma,
  type Actors,
} from './harness';

/**
 * The payment details on the quotation PDF come from the settings an admin
 * edits — read back from the real PDF, not from what the code intended to draw.
 * Needs `pdftotext` (poppler); skipped where it isn't installed.
 */
const hasPdftotext = spawnSync('pdftotext', ['-v']).error === undefined;
const describeIfPdf = hasPdftotext ? describe : describe.skip;

describeIfPdf('payment details on the quotation PDF', () => {
  let actors: Actors;
  let orderId: string;
  const settings = new SettingsService(prisma as never);
  const scratch = mkdtempSync(join(tmpdir(), 'quote-'));

  beforeAll(async () => {
    actors = await createActors();
    const product = await createProduct(actors, { onHand: 100 });
    const service = makeOrders();
    orderId = await placeOrder(service, actors, product.id, 4);
    await service.sendQuotation(orderId, { transportFee: 5 }, actors.staff);
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    return prisma.$disconnect();
  });

  const pdfText = async () => {
    const pdf = await makeOrders().viewQuotation(orderId, actors.customer);
    const file = join(scratch, `q-${Date.now()}.pdf`);
    writeFileSync(file, pdf);
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).replace(
      /[ \t]+/g,
      ' ',
    );
  };
  const set = (values: Record<string, string>) => settings.update(values, actors.staff.id);

  it('a fresh installation invents nothing: the quotation says the team will send the details', async () => {
    const text = await pdfText();
    expect(text).toMatch(/will be sent to you by our team/);
    expect(text).not.toContain('MoMo Pay');
    expect(text).not.toContain('Bank transfer');
  });

  it('shows what an admin has entered — both methods', async () => {
    await set({
      'payment.momoCode': '*182*8*1*77777#',
      'payment.momoName': 'Acme Tiles Ltd',
      'payment.bankName': 'Equity Bank',
      'payment.bankAccountName': 'Acme Tiles Ltd',
      'payment.bankAccountNumber': '4001-998877',
      'payment.bankSwift': 'eqblrwrw',
    });

    const text = await pdfText();

    expect(text).toContain('MoMo Pay');
    expect(text).toContain('*182*8*1*77777#');
    expect(text).toContain('Equity Bank — 4001-998877');
    expect(text).toContain('SWIFT EQBLRWRW');
    expect(text).not.toMatch(/will be sent to you by our team/);
  });

  it('a change reaches the very next quotation opened (nothing is cached)', async () => {
    await set({ 'payment.bankAccountNumber': '5555-000111' });
    const text = await pdfText();
    expect(text).toContain('5555-000111');
    expect(text).not.toContain('4001-998877');
  });

  it('a method with no number is left off', async () => {
    await set({ 'payment.momoCode': '', 'payment.momoName': '' });
    const text = await pdfText();
    expect(text).not.toContain('MoMo Pay');
    expect(text).toContain('Bank transfer');
  });

  it('a malformed value is refused and changes nothing', async () => {
    await expect(set({ 'payment.bankSwift': '!!' })).rejects.toThrow(/SWIFT/);
    const text = await pdfText();
    expect(text).toContain('5555-000111');
  });
});
