/**
 * The root of `@wewin/contract` carries types and nothing else.
 *
 * Same shape as core's root and for the same reason: a component that only needs to
 * know what a `PriceResponseWire` looks like erases to nothing at build time, and the
 * codecs — which pull zod in behind them — can never arrive as a side effect of asking
 * what a response is. Every runtime value lives behind a subpath
 * (`@wewin/contract/pricing`, `/catalog`, `/money`, …).
 */

export type { Exact } from './exact.js';

export type {
  MinorPerSqmTag,
  MinorTag,
  MoneyRateWire,
  MoneyWire,
  ScaledMinorTag,
  ScaledMoneyWire,
} from './money.js';

export type {
  AreaWire,
  BasisPointsWire,
  CountWire,
  LengthWire,
} from './measure.js';

export type {
  CatalogRef,
  CategoryWire,
  ConstValueWire,
  CustomGroupWire,
  ElevationWire,
  NumExprWire,
  OptionGroupWire,
  OptionValueWire,
  PriceDeltaWire,
  ProductDocument,
  ProductDocumentWire,
  ProductWire,
  RuleExprWire,
  RuleWire,
  SkuGroupWire,
} from './catalog.js';

export type {
  IssueWire,
  OptionStateWire,
  OptionStatesWire,
  PriceBreakdownWire,
  PriceLineWire,
  PriceRequest,
  PriceRequestWire,
  PriceResponse,
  PriceResponseWire,
} from './pricing.js';

export type { CatalogStaleBodyWire } from './errors.js';

export type {
  ApproveRedesignRequestWire,
  AvailableTransitionWire,
  BounceOrderRequestWire,
  CancelOrderRequestWire,
  ChangeRequestResolutionWire,
  ChangeRequestWire,
  ConfirmPaymentRequestWire,
  CreateChangeRequestWire,
  CreateOrderRequestWire,
  OrderActorKindWire,
  OrderContactRequestWire,
  OrderContactWire,
  OrderDocumentLineWire,
  OrderDocumentWire,
  OrderEventListWire,
  OrderEventTypeWire,
  OrderEventWire,
  OrderLineRequestWire,
  OrderListWire,
  OrderMoneyWire,
  OrderPayloadKindWire,
  OrderStatusWire,
  OrderSummaryWire,
  OrderWire,
  ResolveChangeRequestWire,
  StaffCancelOrderRequestWire,
  SubmitOrderRequestWire,
  SupersedeOrderRequestWire,
  VatTreatmentWire,
} from './order.js';

export type {
  AuthorScheduleRequestWire,
  InstalmentBasisWire,
  InstalmentSource,
  InstalmentWire,
  PaymentScheduleWire,
  ScheduleCloseReasonWire,
  ScheduleTermWire,
} from './schedule.js';

export type {
  AdminOptionGroupListWire,
  AdminOptionGroupWire,
  AdminOptionValueWire,
  AdminProductListWire,
  AdminProductSummaryWire,
  AdminProductWire,
  CreateOptionGroupRequestWire,
  CreateOptionValueRequestWire,
  CreateProductRequestWire,
  DraftCustomOptionWire,
  DraftMutationWire,
  DraftOptionWire,
  DraftRuleWire,
  DraftSkuOptionWire,
  DraftSummaryWire,
  DraftWire,
  ProductFieldsPatchWire,
  ProductFieldsWire,
  PublishDraftRequestWire,
  PublishResultWire,
  PublishedVersionWire,
  PutDraftOptionRequestWire,
  PutDraftRuleRequestWire,
  SetOptionValueAvailabilityRequestWire,
  StoredPriceDelta,
  UpdateOptionGroupRequestWire,
  UpdateOptionValueRequestWire,
  UpdateProductDraftRequestWire,
} from './admin.js';
