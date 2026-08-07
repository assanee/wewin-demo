/**
 * What the rest of the app imports from the order lifecycle: the module, and very little else.
 *
 * `OrdersService` and `OrderRepository` are wiring. A feature module that reached for either
 * would be a second thing driving the state machine, and the invariants this round rests on —
 * the event is written before the order moves, the payload schema is chosen after the row is
 * locked, the outbox is produced by the spine and by nothing else — hold only while there is
 * one path through it.
 *
 * The pure functions *are* exported, because they carry decisions other rounds will need to
 * read rather than re-derive: 5b's forfeit arithmetic starts from `faultFor`'s answer, and 5c
 * has to call `assertScopeUnchanged` before it can offer a revision for approval.
 *
 * `./scope` is re-exported through its own index and is not repeated here.
 */

export { OrdersModule } from './orders.module';
export { DocumentLinkModule } from './document-link.module';

export {
  BP_DENOMINATOR,
  DEFAULT_LOCALE,
  DEFAULT_VAT_RULE,
  SCHEDULED_DEPOSIT_BP_DEFAULT,
} from './defaults';

export {
  absorbedDeltaMinor,
  assertScopeUnchanged,
  orderDocumentHash,
  priceOrderDocument,
  scopeViolations,
  withHash,
  type CatalogEntry,
  type PricedDocument,
  type PriceOrderParams,
  type ScopeViolation,
} from './order-document';

export {
  assertActorMayMove,
  faultFor,
  parseTransitionBody,
  payloadSchemaFor,
  type FaultInput,
  type OrderActor,
  type OrderFault,
  type TransitionBody,
  type TransitionRow,
} from './transitions';

export { translateOrderError, withTranslatedOrderErrors } from './pg-errors';
