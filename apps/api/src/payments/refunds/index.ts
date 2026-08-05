/**
 * What the rest of the application imports.
 *
 * `RefundsService` is exported for one future caller and no current one: the cancellation path
 * in `src/orders`, which should post the forfeit at the moment the order is cancelled rather
 * than leaving it to whoever asks for the money back. See the note on `RefundsService.request`.
 */

export { RefundsModule } from './refunds.module';
export { RefundsService } from './refunds.service';
export { RefundsRepository } from './refunds.repository';
export type {
  CreateRefundWire,
  DecideRefundWire,
  DisburseRefundWire,
  RefundDetailWire,
  RefundListWire,
  RefundWire,
} from './refunds.contract';
