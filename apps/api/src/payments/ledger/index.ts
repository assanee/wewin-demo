/**
 * What the rest of the payments phase imports.
 *
 * Modules reach for this file and not for the ones behind it. In particular, nothing outside
 * this directory should import `postings.ts`: `debit` and `credit` are how the chart of
 * accounts stays a set of rules rather than a list of names, and a service assembling its own
 * legs is the second design that posts a bank fee to `revenue` (plan 7.13).
 */

export { LedgerModule } from './ledger.module';
export { LedgerService } from './ledger.service';
export { LedgerRepository, type LedgerTx, type OrderMoney } from './ledger.repository';
export { translatePaymentError, withTranslatedPaymentErrors } from './pg-errors';
