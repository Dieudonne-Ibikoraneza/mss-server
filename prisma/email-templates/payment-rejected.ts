import { Language } from '@prisma/client';
import { emailShell } from './email-shell';

/**
 * Sent when staff could not confirm a payment the customer declared
 * (`OrdersService#rejectPayment`). Variables: fullName, orderNumber, orderUrl,
 * reason (typed by staff), minutes (how long the order stays reserved).
 */
export const paymentRejectedTemplates = [
  {
    key: 'PAYMENT_REJECTED',
    language: Language.EN,
    subject: "We couldn't confirm your payment for order {{orderNumber}}",
    bodyText:
      "Hi {{fullName}},\n\nWe couldn't confirm the payment you reported for order {{orderNumber}}.\n\n" +
      'Reason: {{reason}}\n\nYour order is still reserved for you for the next {{minutes}} minutes. ' +
      'Please check the payment details on your quotation, pay again if needed, and mark the order as paid once done:\n\n{{orderUrl}}',
    bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 16px;">Hi {{fullName}},</p>
        <p style="font-size: 15px; margin: 0 0 16px;">We couldn't confirm the payment you reported for order <strong>{{orderNumber}}</strong>.</p>
        <p style="font-size: 15px; margin: 0 0 16px; padding: 12px 14px; background: #fef3c7; border-radius: 6px;"><strong>Reason:</strong> {{reason}}</p>
        <p style="font-size: 15px; margin: 0 0 16px;">Your order is still reserved for you for the next {{minutes}} minutes. Please check the payment details on your quotation, pay again if needed, and mark the order as paid once done.</p>
        <p style="margin: 0 0 16px;"><a href="{{orderUrl}}" style="display: inline-block; background: #b8860b; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">View order</a></p>
      `),
  },
  {
    key: 'PAYMENT_REJECTED',
    language: Language.RW,
    subject: "Ntitwashoboye kwemeza ubwishyu bw'itumizo {{orderNumber}}",
    bodyText:
      'Muraho {{fullName}},\n\nNtitwashoboye kwemeza ubwishyu wavuze ku itumizo {{orderNumber}}.\n\n' +
      "Icyabiteye: {{reason}}\n\nItumizo ryawe riracyabitswe mu minota {{minutes}} iri imbere. " +
      "Reba neza amakuru y'ubwishyu ari ku giciro cyawe, wongere wishyure niba bibaye ngombwa, hanyuma ushyireho ko wishyuye:\n\n{{orderUrl}}",
    bodyHtml: emailShell(`
        <p style="font-size: 15px; margin: 0 0 16px;">Muraho {{fullName}},</p>
        <p style="font-size: 15px; margin: 0 0 16px;">Ntitwashoboye kwemeza ubwishyu wavuze ku itumizo <strong>{{orderNumber}}</strong>.</p>
        <p style="font-size: 15px; margin: 0 0 16px; padding: 12px 14px; background: #fef3c7; border-radius: 6px;"><strong>Icyabiteye:</strong> {{reason}}</p>
        <p style="font-size: 15px; margin: 0 0 16px;">Itumizo ryawe riracyabitswe mu minota {{minutes}} iri imbere. Reba neza amakuru y'ubwishyu ari ku giciro cyawe, wongere wishyure niba bibaye ngombwa, hanyuma ushyireho ko wishyuye.</p>
        <p style="margin: 0 0 16px;"><a href="{{orderUrl}}" style="display: inline-block; background: #b8860b; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Reba itumizo</a></p>
      `),
  },
];
