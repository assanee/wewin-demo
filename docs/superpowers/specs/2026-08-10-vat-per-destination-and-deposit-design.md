# VAT per destination country, the destination field, and the deposit percentage

**Date** 2026-08-10
**Status** design agreed with the owner; not yet planned or built
**Scope** P2 of the two-part split opened by
`2026-08-09-organisation-settings-and-customer-slip-design.md`, whose line 5 reserved this
work: *"P2 — VAT per destination country, the destination-country field, and the deposit
percentage — is agreed in principle and has not been specified yet; it gets its own spec
before any of it is built."* This is that spec.

P1 shipped the settings foundation: `organisation_profile`, `bank_accounts`,
`bank_account_changes`, the customer slip page, and the PromptPay payload. P2 turns the
three numbers P1 deliberately left as constants into configuration.

---

## 1. What exists today, established first-hand

Nothing here is inferred. Each claim carries the file and line that proves it.

**One global VAT rule, no route to change it.** `DEFAULT_VAT_RULE = { rateBp: 700,
treatment: 'standard' }` at `apps/api/src/orders/defaults.ts:33-36` feeds every computation
and every pin. Live database: all 21 issued documents are `700 | standard`; `select
count(distinct pinned_vat_rate_bp) from order_documents` returns 1.

**Two tax functions, and nothing else computes tax.** `packages/core/src/vat.ts` is 72 lines
and exports exactly `fromNet(netMinor, rule)` at `:50` and `fromGrand(grandMinor, rule)` at
`:65`. Rounding is `divRoundHalfUp` — half away from zero, bigint, no float
(`packages/core/src/money.ts:56-69`). `fromNet` rounds the VAT and adds; `fromGrand` rounds
the net and derives VAT by subtraction so the three figures always foot, with the reason
stated at `vat.ts:61-63`.

**VAT-inclusive arithmetic is already live**, not dormant. `fromGrand` runs today whenever
staff set a grand-total override (`apps/api/src/quotes/overrides.ts:246`). What does not
exist is inclusive *catalogue* pricing: `packages/core/src/pricing.ts` contains zero
occurrences of `vat` or `tax`.

**The percentage-deposit generator already exists and is fully tested.**
`depositPercentTerms(percentBp)` at `apps/api/src/payments/schedule/terms.ts:71-74`, exported
at `payments/schedule/index.ts:41`, exercised in six test files. It refuses 0 bp and refuses
anything above 10 000 bp (`plan.test.ts:171-177`). P2(c) needs no new deposit arithmetic.

**The concession floor is already a parameter — one level deeper than it looks.**
`cashflowConcessionMinor(totalMinor, rows, floorBp = GATE_COVERAGE_BP_DEFAULT)` at
`apps/api/src/payments/schedule/plan.ts:446-454`. Its only caller,
`apps/api/src/quotes/authority/concession.ts:365`, omits `floorBp` and so inherits 10 000 bp —
payment in full.

An earlier draft of this spec called that omitted argument "the whole of the deposit change". It
is not. Line 365 sits **inside** `measureCashflow(grandTotalThbMinor, instalments)`
(`concession.ts:361-365`), which has no floor parameter to forward, and `pinsForSubmit(tx,
grandTotalThbMinor)` has no terms parameter to receive one. The seams exist; reaching them is
the four groups of edits enumerated in §5.3 as F through I.

**Treatments are named, not implemented.** `charges()` at `vat.ts:47` is `treatment ===
'standard' && rateBp > 0`, so `zero_rated`, `exempt` and `out_of_scope` all yield zero VAT
regardless of rate. Their only downstream difference is a Thai label,
`vatLabelTh` at `apps/dashboard/src/components/quotes/quote-alerts.tsx:205-219`.

**No country concept exists anywhere.** No country column, no ISO code, no address country
in `packages/db/src/schema/**` and none in the live database.

**A pinned document can never be edited.** `order_documents_freeze`
(`packages/db/drizzle/0007_order_guards.sql:564-588`, confirmed live in `pg_trigger`) raises
unconditionally on any UPDATE (`:568-571`); on DELETE it raises only when the parent order is
not an unsubmitted draft (`:575-580`), so a draft's document can still be deleted. For the 21
**issued** documents — every one belonging to a submitted order — both doors are shut.
**No backfill of any pinned value is possible.** Anything P2 pins must be present at INSERT.

**A version bump is a 503 for every issued quotation.** `documentSchemaVersion` is a bare
`z.literal(ORDER_DOCUMENT_SCHEMA_VERSION)` at `packages/contract/src/order.ts:303` with no
v1/v2 union reader. `apps/api/src/orders/order.repository.ts:722-729` maps any parse failure
to `AppError.databaseUnavailable` — HTTP 503, not a graceful degrade — and all three document
read paths funnel through that one decoder (`:542`, `:586`).

**The inverse failure is quieter and worse.** The decoder returns `parsed.data`, not the raw
row (`order.repository.ts:735`), and `z.object` strips unknown keys. A field written into the
pinned JSON but absent from `orderDocumentWireSchema` is **silently deleted on every read,
forever**, with no error and no log — and the freeze trigger means it can never be repaired.
There is no read-time hash verification: `withHash`/`orderDocumentHash`
(`apps/api/src/orders/order-document.ts:384-391`) are called only at build time (`:325`).

**Line amounts in the document are net.** `PinnedLine.netMinor`
(`packages/core/src/quotation.ts:48`) receives the **effective** figure at
`order-document.ts:299` and `:314` — `netMinor: encodeThb(applied.effectiveTotalThbMinor)`. The
assignment at `:240` is a placeholder whose own comment says so (`:239`: *"Replaced below with
the effective figure"*), so it is the wrong line to read. The document's own net comes from
`netThbMinor: taxed.netMinor` at `:368`.

Under `fromNet` those agree by construction. **Under `fromGrand` they diverge, and nothing
catches it**: the only footing constraint is `order_documents_total_foots` — `grand = net + vat`
(`packages/db/drizzle/0006_orders.sql:116`) — which says nothing about lines summing to
anything. Note also that `lines` and `charges` are two separate arrays in the document
(`packages/contract/src/order.ts:313-314`), so the quantity that must equal the grand total is
their combined sum, not the lines alone.

**`pinnedLocale` is the precedent to copy, and it lives in both places.** It is a column on
`order_documents` *and* a field inside the JSON, read at
`packages/core/src/quotation.ts:327` with the comment *"⚠️ From the document, never from the
browser. This is the whole of plan 10.6."* It reaches the document via
`apps/api/src/orders/orders.service.ts:749` and `:791`.

---

## 2. Decisions the owner made

Recorded verbatim in effect, because each one closes a question the code cannot answer.

| # | Question | Decision |
|---|---|---|
| D1 | What does a catalogue price mean for a country set to "VAT included"? | **The setting selects the formula.** Inclusive → `fromGrand(price)`; exclusive → `fromNet(price)`. For an inclusive country the customer transfers the catalogue price and the company nets less. |
| D2 | Does a deposit at company policy require approval? | **Policy is the normal line.** Setting the policy to 30% makes 30% unremarkable; below policy still requires approval. The control moves, it does not disappear. |
| D3 | How much history does a VAT change keep? | **Full before/after history**, the `bank_accounts` pattern, not the `organisation_profile` pattern. |
| D4 | Where does the deposit percentage live? | **One number for the whole company**, not per country — which obliges a new `organisation_profile_changes` history table, since that table has none today. |
| D5 | What do line amounts show for an inclusive country? | **The price the customer saw in the catalogue.** Lines and charges together sum to the grand total; net and VAT appear as a breakdown beneath. |
| D6 | What should the storefront's VAT copy say, given it is prerendered and cannot read a rate? | **Remove it.** The storefront makes no tax claim; the quotation carries the truth. |

Two decisions carried forward from P1 and still binding:

- **Deletion is always a status flag, never a real DELETE.** Enforced mechanically:
  `bank_accounts_block_delete` in `packages/db/drizzle/0027_organisation.sql`. P2's tables get
  the same treatment.
- `apps/api/src/orders/defaults.ts` keeps its header: *"THE NUMBERS ON THIS PAGE ARE
  DEFAULTS, NOT DECISIONS."* After P2 the file still holds defaults — it stops being the only
  place they can be changed.

---

## 3. Why D1 does not contradict `vat.ts`

`vat.ts:6-16` states an invariant that any tax design in this repo must answer to:

> The business decision was "make VAT configurable". Taken literally that would let a quote
> declare whether its own total includes tax, which makes the figure filed on a ภ.พ.30 return
> something a salesperson types. So the configurable part is the rate and the treatment, and
> the fixed part is this: `grandMinor` always includes VAT. […] Inclusive-versus-exclusive
> stops being a property of the data and becomes a property of the keyboard the number
> arrived from.

That header states two things, and D1 stands differently against each. An earlier draft of this
spec claimed D1 satisfied the whole header; it does not, and the honest account matters because
this is the one place P2 changes a stated invariant rather than extending one.

**Clause 1 — `grandMinor` always includes VAT — is preserved exactly.** `fromGrand` returns
`grandMinor` unchanged and derives the net from it (`vat.ts:65-71`), so every downstream
consumer — instalments, deposit percentages, forfeits, refunds — keeps referring to the same
figure with the same meaning. `vatMinor` remains derived and is still never typed by a human.

**Clause 2 — "inclusive-versus-exclusive stops being a property of the data" — is amended.**
D1 makes the basis data in two places: a column on `tax_countries` and a field in the pinned
document. Calling that "a record, not a knob" would be sophistry: a value the software reads to
choose a formula is a knob, whatever it is named.

**Why the amendment is safe.** The header's stated fear is precise — *"which makes the figure
filed on a ภ.พ.30 return something a salesperson types."* That fear is about **who** sets the
basis and **at what granularity**, and both are answered:

- The basis is set once per country, in company settings, behind `organisation.write` — the
  same permission that governs the company's tax ID. It is not a field on a quotation and no
  sales screen exposes it.
- **`TaxRule` still stays two fields.** Nothing in the type system permits a per-line or
  per-quote basis, so no future code path can drift into one without changing the core type
  deliberately.
- The document's copy is written by the server at submit from the resolved country, never from
  a request body.

**The residual risk, stated rather than hidden.** Settings are not versioned against carts. A
cart priced while a country was exclusive and submitted after an admin flips it to inclusive
computes inclusive at submit, so the customer may see a total that differs from what they
browsed. Nothing is falsified — the pinned document records the basis that actually ran, and
`tax_country_changes` records when the flip happened, so any discrepancy is explainable after
the fact. It is not prevented, and no deliverable in P2 prevents it.

**`vat.ts`'s header is therefore part of the deliverable, not collateral.** Clause 2 is
rewritten in place to say what becomes true: the basis is a property of the destination's
settings, set by whoever holds `organisation.write`, and never a property of an individual
quote. A header left asserting the opposite of what the code does is the drift this repo spends
its comments fighting.

---

## 4. Data model

### 4.1 `tax_countries`

One row per country the company actually sells to. Modelled on `bank_accounts`.

| Column | Type | Notes |
|---|---|---|
| `code` | `char(2)` PK | ISO 3166-1 alpha-2, uppercase |
| `name_th` | `text` NOT NULL | Thai source content, like `organisation_profile.legal_name_th` |
| `rate_bp` | `integer` NOT NULL | Basis points |
| `treatment` | `text` NOT NULL | One of the four |
| `prices_include_tax` | `boolean` NOT NULL | D1's switch |
| `is_active` | `boolean` NOT NULL DEFAULT true | Withdrawal is a flag |
| `sort_order` | `integer` NOT NULL DEFAULT 0 | |
| `updated_by_user_id` | `uuid` → `users.id` | |
| `created_at` / `updated_at` | `timestamptz` | |

Constraints:

- `tax_countries_code_shape` — `code ~ '^[A-Z]{2}$'`
- `tax_countries_rate_in_range` — `rate_bp between 0 and 10000`.
  **This bound must be in the database.** `assertRate` at `vat.ts:40-44` rejects
  non-integers and negatives only — it has *no upper bound*, and a rate of 15 000 bp
  computes without complaint. Today the ceiling exists only in zod
  (`packages/contract/src/order.ts:310`, `quote.ts:610`) and in
  `order_documents_vat_rate_in_range`. A per-country table that calls core directly would
  otherwise have no ceiling at all.
- `tax_countries_treatment_allowed` — a CHECK listing the four treatments as literals.
  A CHECK, not a `pgEnum`, following the reason recorded for `bank_accounts.bank_code`: the
  set is data, and an enum makes changing it a migration.
- `tax_countries_block_delete` — BEFORE DELETE trigger raising unconditionally.

Seed: **exactly one row.** `('TH', 'ไทย', 700, 'standard', false, true, 0)`, taking its
numbers from `DEFAULT_VAT_RULE` so the two cannot disagree on day one.

**No foreign VAT rates are seeded.** Inventing "Singapore 9%" would put an authoritative-looking
number in a tax table that nobody verified, and the storefront's country list is built from
this table — so seeding countries the company does not sell to would offer customers
destinations that do not exist. The admin adds each country deliberately.

### 4.2 `tax_country_changes`

Append-only, one row per change, carrying every field before and after. Directly modelled on
`bank_account_changes`:

- `tax_country_changes_append_only` — BEFORE UPDATE OR DELETE trigger raising
  unconditionally.
- `changed_by_user_id` → `users.id`, `changed_at timestamptz`.
- Contiguity: `before` of row *N* equals `after` of row *N−1*. Guaranteed by the service, not
  the schema — see §7.

### 4.3 `organisation_profile.deposit_bp` and `organisation_profile_changes`

- New column `deposit_bp smallint NOT NULL`, CHECK `deposit_bp between 1 and 10000`. The lower
  bound is 1, not 0, because `depositPercentTerms` already refuses 0 (`plan.test.ts:171-177`) —
  the CHECK reports the refusal at the right layer instead of letting a stored 0 throw at
  submit.
- **No column DEFAULT.** The value 10 000 is written into the single `organisation_profile` row
  by the migration, and the column itself carries no default. This is not a style preference:
  `apps/api/src/orders/defaults.ts:12-15` forbids the mechanism in so many words — *"None of
  them is a column default in Postgres: a `DEFAULT 700` in a migration is exactly how a
  placeholder becomes a fact nobody remembers choosing, which is why `packages/db` deliberately
  has none and the API passes and pins the value instead."* §2 carries that header forward as
  binding, so a `DEFAULT 10000` here would contradict this spec three sections after it made the
  promise. Seeding the row achieves the same starting behaviour and leaves the number somewhere a
  person can see it was chosen.
- New table `organisation_profile_changes`, append-only, same shape and triggers as
  `tax_country_changes`, covering the whole profile row.

This second table is the price of D4. It is not scope creep for its own sake: the owner asked
for the deposit as one company-wide number *and* for money settings to carry full history, and
`organisation_profile` has no history table. A side effect is that changing the company's tax
ID or address also becomes traceable, which it is not today.

### 4.4 `orders.destination_country`

New column `destination_country char(2) NULL`, with CHECK `destination_country ~ '^[A-Z]{2}$'`.

**Nullable and mutable, deliberately.** Nullable because all 25 existing orders — the 21 that
carry an issued document and the 4 drafts that do not — have no
destination and no value can be invented for them (D4 of the P1 spec's reasoning applies:
migration 0017 deleted rows rather than fabricate a value for a new NOT NULL pinned column, and
said so in its own text). Mutable because a customer who picks the wrong country should be
correctable — the tax that country produced stays pinned on the issued quotation, while the
order's own record of the destination can be fixed for whatever is quoted next.

**No foreign key to `tax_countries`.** Resolution (§5.1) does the checking, so it can answer with
a readable validation error rather than a constraint violation — and, more importantly, so it can
distinguish *withdrawn* from *unknown*. An FK cannot: it would treat both alike. §5.1 steps 2 and
3 draw that line, and the omitted FK is what makes drawing it possible.

---

## 5. Computation

### 5.1 Resolving the rule

A new module `apps/api/src/organisation/tax-country.service.ts` (beside the P1
`organisation.service.ts`) resolves a destination code to a rule plus a basis:

```ts
interface DestinationTax {
  readonly code: string | null;      // null when the order names no destination
  readonly rule: TaxRule;            // { rateBp, treatment } — unchanged shape
  readonly basis: 'inclusive' | 'exclusive';
}
```

Resolution order, and the reason for each step:

1. Order names a destination and the row exists and is active → that row.
2. Order names a destination whose row exists but is **inactive** → **that row, resolved
   normally.** `is_active` governs whether a country is *offered to new customers*, not whether
   an existing cart is valid. Refusing here would mean an admin withdrawing a country bricks
   every cart already carrying it — turning the routine withdrawal §4.1 describes into a
   customer-facing outage. It would also make §4.4's decision to omit the foreign key pointless:
   the constraint violation would merely have been relabelled as a validation error.
3. Order names a destination with **no row at all** → **refuse the submit** with a validation
   failure. This is not a withdrawal; `tax_countries_block_delete` means a row that once existed
   still exists, so an unknown code is a client bug or a tampered request. Silently falling back
   to Thai VAT would compute a Thai tax on a foreign sale and pin it, permanently, with nothing
   recording that a fallback happened.
4. Order names no destination → `DEFAULT_VAT_RULE` with `basis: 'exclusive'`, `code: null`.
   This is the path every existing order and every un-migrated cart takes.

### 5.2 Applying it

**A rate that is not injected is not configurable.** The formula switch is the smaller half of
this change; the larger half is that `DEFAULT_VAT_RULE` is hardcoded at every site that takes
tax, and the pinned columns are hardcoded too. An implementer who changes only the formula
ships a feature named "VAT per destination country" that computes and pins 700 bp for every
country. The edits, enumerated:

**A. The submit path — where the rule enters and is pinned.**

| Site | Today | Becomes |
|---|---|---|
| `apps/api/src/orders/orders.service.ts:721` | `vat: DEFAULT_VAT_RULE` into `priceOrderDocument` | `vat: destination.rule` |
| `apps/api/src/orders/orders.service.ts:747-748` | `pinnedVatRateBp: DEFAULT_VAT_RULE.rateBp`, `pinnedVatTreatment: DEFAULT_VAT_RULE.treatment` | both from `destination.rule` |

Without A, nothing else in §5 matters.

**B. `applyOverrides` — the two `fromNet` calls, both of which must take the basis.**

`ApplyOverridesInput` (`apps/api/src/quotes/overrides.ts:168-175`) carries `vat: TaxRule` and
no basis; it gains `basis: 'inclusive' | 'exclusive'`. Then:

```
:224  money branch      exclusive → fromNet(taxableNet, vat)    inclusive → fromGrand(taxableNet, vat)
:268  baseline branch   the same switch, for the same reason
:246  grand-total override      UNCHANGED — see below
```

`:268` is not optional and is the easiest thing here to miss. It computes the concession
*baseline* with `fromNet(baseTaxable, vat)`, which reaches the dashboard through
`apps/api/src/quotes/encode.ts:96` as `baselineGrandTotalThbMinor`. Left exclusive while `:224`
goes inclusive, the baseline sits ~7–9% above the effective total, so **every inclusive quote
with nothing negotiated displays a phantom concession** — and a phantom concession is measured
by the authority gate, which is fail-closed.

`:246` stays as it is. It is reserved for a human grand-total override, and it carries the
exempt-charge split and the `belowExempt` refusal that raises
`{ reason: 'grand_total_below_exempt_charges' }` (`order-document.ts:279-284`). A grand-total
override on an inclusive order therefore composes unchanged: the typed figure is the later
authority and is re-derived through `:246`. A test pins that composition rather than assuming it.

**C. The sales quote screen — five call sites, or staff and customer disagree.**

`QuotesService.effective(lines, overrides)`
(`apps/api/src/quotes/quotes.service.ts:864-871`) hardcodes `vat: DEFAULT_VAT_RULE` and takes
no order, and it is called at **five** sites: `:143`, `:210`, `:812`, `:978`, `:1088`. Each must
resolve the order's destination and pass the rule and basis through.

This is not polish. `order-document.ts:254` forbids itself from calling `fromNet` precisely so
that the document and the quote screen cannot diverge — its comment names "how the invoice and
the quote screen would come apart" as the thing it prevents. Leaving `effective()` exclusive
while the document goes inclusive recreates exactly that divergence: staff quote one figure and
the customer receives another.

**D. Per-line tax inside approval measurement — deliberately untouched.**

`apps/api/src/quotes/authority/concession.ts:195` and `:332` gross lines up individually
(`grossUp`). They stay exclusive-only. Two reasons, and the second is the repo's own: the
figure is never printed — `concession.ts:187` accepts a satang-per-source divergence on that
basis — and the margin dimension measures *movement between two states*, both computed the same
way, so a uniform basis cancels out of the difference. §11 test 7 pins that a document-level
basis change does not move a margin measurement.

**E. Per-line tax in the document — still forbidden.** Tax is taken once, at document level.
Nothing in P2 introduces a per-line VAT figure into a document.

### 5.3 What the deposit change actually costs

Not three edits. The seams exist but each is a parameter deeper than it first appears, and one
existing green test goes red on day one.

**F. Reading the number, once, in the caller that owns the transaction.**

`OrdersService.submit` reads `organisation_profile.deposit_bp` inside the submit transaction and
passes it to both consumers below. It is read there rather than inside
`apps/api/src/quotes/authority` because that module's header records that it deliberately
imports neither `OrdersModule` nor `ScheduleModule`, and a settings read is not a reason to
break that. One read, two consumers, no new module coupling.

**G. Threading it into the schedule.**

`pinsForSubmit` has no terms parameter today — there is nowhere to put
`depositPercentTerms(...)`. Three signatures change:

| Site | Today | Becomes |
|---|---|---|
| `apps/api/src/payments/lifecycle/lifecycle.service.ts:105-113` | `pinsForSubmit(tx, grandTotalThbMinor)` → `schedule.plan(grandTotalThbMinor)` | gains `depositBp`, passes the terms it selects |
| `apps/api/src/orders/orders.service.ts:774` | `pinsForSubmit(tx, priced.grandTotalThbMinor)` | supplies `depositBp` from F |

**At 10 000 bp the terms must stay what they are today.** `depositPercentTerms(10_000)` returns
**two** rows — a gating `percent` row plus a `remainder` due `0n` — where submit produces one
row now. So the selection is conditional: `deposit_bp === 10_000` keeps the existing
pay-in-full terms; anything less uses `depositPercentTerms(deposit_bp)`. Without this the
default configuration changes behaviour, and
`apps/api/tests/payments/lifecycle/lifecycle.pg.test.ts:188` — `expect(rows).toHaveLength(1)` —
fails on a feature nobody switched on. That test is listed in the plan as a test to *read and
keep green*, not to change.

**H. Threading it into the concession measurement.**

`concession.ts:365` is inside `measureCashflow(grandTotalThbMinor, instalments)` — two
parameters, no floor. Three changes:

| Site | Change |
|---|---|
| `apps/api/src/quotes/authority/concession.ts:361-365` | `measureCashflow` gains `floorBp`, and passes it as `cashflowConcessionMinor`'s third argument |
| `apps/api/src/quotes/authority/authority.service.ts:178-179` | both calls — `measureCashflow(0n, [])` and `measureCashflow(grandTotal, instalments)` — supply it |
| `authority.service.ts` `private async measureFor(order, tx)` (`:142`) | gains the floor, from `gate()`'s caller |

**I. Prose and a dead constant.** `CASHFLOW_FLOOR_BP_DEFAULT` (`authority.service.ts:615`) is a
re-export that **nothing reads** — the live floor is `plan.ts:449`'s default parameter. Editing
it changes no behaviour, and being a module-level constant it cannot hold a per-row database
value. It is a documentation edit, listed here only so nobody mistakes it for the mechanism.
The prose at `authority.service.ts:66-74` is likewise updated: its sentence *"authoring a
deposit below payment-in-full will demand an approval that fail-closed cannot grant"* stops
being true for a deposit **at** policy, and stays true for one below it.

**Why H is load-bearing rather than tidy.** Without it, the first configured deposit under 100%
makes **every** submit throw and roll back the whole transaction — document, order, schedule and
status event — because the gate runs inside the submit transaction
(`orders.service.ts:830`), a below-floor schedule measures as a cashflow concession, and
`authority_limits` has zero rows, so fail-closed cannot grant the approval it demands.

---

## 6. The destination field, from form to frozen document

### 6.1 The journey

Six hops. Contract first, because both submit bodies are `strictObject` and an undeclared key is
a 400 rather than an ignored field (`apps/api/src/orders/transitions.ts:100-104`).

**The order below is the code's order, which is not the intuitive one.** The document is priced
at `orders.service.ts:715` and pinned at `:741`, while the order row is written by
`applySubmission` at `:776`. So the destination must be **resolved before the document is
priced**, and therefore before the order row that records it is written. An earlier draft of
this spec listed the order row before resolution, which would have an implementer resolving the
destination after the document had already been pinned without it.

1. **Contract.** `orderContactRequestSchema`
   (`packages/contract/src/order.ts:622-633`) gains `destinationCountry:
   z.string().regex(/^[A-Z]{2}$/u).optional()`. It is a `.strictObject(...).refine(...)` —
   a `ZodEffects`, **not** an object schema — so it cannot be `.extend()`ed: the object
   literal is edited in place, and the `OrderContactRequestWire` interface beside it is
   edited to match.
2. **Storefront form.** A `ประเทศปลายทาง` select on `RequestQuotationForm`, options from
   the public read of §7.3, ordered by `sort_order`, defaulting to `TH`. It joins the
   contact fields that P1's pre-fill work already remembers
   (`apps/web/src/lib/quote/prefillContact.ts`), so a returning customer does not re-pick
   their own country.
3. **Resolution — before `priceOrderDocument` at `orders.service.ts:715`.** The code is taken
   as `body.contact.destinationCountry ?? order.destinationCountry`, the **same fallback shape
   as every other contact field** (`:780-790`, whose comment records that *"a submit that
   carries only a telephone number must not erase an address a cart already had"*). Reading it
   from the body alone would silently erase a destination the cart already held. §5.1 then turns
   the code into a `DestinationTax`, or refuses.
4. **Document.** Priced at `:715` with `vat: destination.rule` (§5.2 edit A), pinned at `:741`
   with the rate, treatment, code and basis. Permanent from this point.
5. **Order row.** `applySubmission` at `:776` records `destination_country` (§4.4) — after the
   document, not before.
6. **Read-back, or the pre-fill in hop 2 cannot work.** `OrderContactWire`
   (`packages/contract/src/order.ts:387`) carries `name`, `phone` and `email` and no
   destination, and `apps/web/src/lib/quote/prefillContact.ts:47-58` reads the prior order's
   contact back out of `GET /orders/:id`. Without extending that wire type, its encoder, and the
   repository's column selection, the country can never be pre-filled. This hop is listed
   separately because it is easy to believe hop 2 delivers the benefit on its own; it does not.

### 6.2 What is pinned

Two new fields inside the pinned JSON, both **optional**:

```
destinationCountry?: string   // 'SG'; absent on the 21 existing documents
taxBasis?: 'inclusive' | 'exclusive'
```

**Optional is what makes this safe.** `documentSchemaVersion` stays at its current literal.
An optional field is absent from the 21 stored documents, absent parses clean, and no
version bump occurs — so no issued quotation stops printing. A **required** field would 503
all 21.

**Both fields must be declared in `orderDocumentWireSchema`
(`packages/contract/src/order.ts:302`) *and* in the `OrderDocumentWire` interface it is annotated
against (`:229ff`).** The schema is typed `z.ZodType<OrderDocumentWire>`, so declaring a field in
only one of the two does not compile — the same two-sided obligation §6.1 hop 1 names for
`OrderContactRequestWire`.

This is not optional bookkeeping: a field written into the JSON but undeclared is stripped by
`z.object` and returned absent by `order.repository.ts:735` on every read, forever, silently, and
the freeze trigger means it can never be repaired. **The plan's first test must be the one that
catches this** — write a document with both fields, read it back through the repository, assert
both survive. A test that only checks the write is worthless here.

`taxBasis` earns its place in the JSON rather than a column for a concrete reason: the
customer's printed quotation is rendered from the document
(`pinnedDocumentFrom` at `packages/core/src/quotation.ts:315`), and it must choose a layout
(§8). It cannot ask `tax_countries`, because that table is mutable — the country's basis may
have changed since the quotation was issued, and the printed page must show what was quoted.

**No `pinned_destination_country` column.** `orders.destination_country` answers reporting
questions. If staff later correct the order's country, the order and its issued quotation will
disagree — and that is correct: the quotation records what was quoted, not what is true today.

`pinnedDocumentFrom` reads both leniently, in the style of its neighbours: `taxBasis` defaults
to `'exclusive'`, `destinationCountry` to `null`. It is a decoder for documents older than the
field.

---

## 7. Services, routes, permissions

### 7.1 The write pattern, copied exactly

Every write and its history row are **one transaction**, and the pre-image is read under a row
lock. From `apps/api/src/organisation/organisation.service.ts:31-40` and `:77`:
`SELECT … FOR UPDATE` before the UPDATE, history INSERT as the last statement. This is not
stylistic — P1's final review found that an unlocked pre-image read lets concurrent PATCHes
break history contiguity (`before[N] == after[N-1]`), and `FOR UPDATE` is the house pattern at
eight sites.

### 7.2 Permissions — reuse, do not invent

P2 reuses **`organisation.read`** and **`organisation.write`**
(`apps/api/src/rbac/permissions.ts:61-62`), for one reason: tax settings *are* company
settings, and `organisation.write` already means "edit the company's settings". Inventing
`tax.write` would split one idea across two codes.

**The reason is not that reuse avoids a 403.** It does not. No migration grants
`organisation.read` or `organisation.write` to any group — `grep` for either code across
`packages/db/drizzle/*.sql` returns nothing, and
`apps/api/tests/organisation/organisation.pg.test.ts:126-127` mints them per test via
`makeActor`. So the new routes are unreachable until somebody writes a grant, exactly as a new
code would be. That is true of P1's routes today and is not a P2 problem to solve; it is stated
here only so an implementer does not read "reuse" as "works out of the box" and spend a day
debugging a 403 that is the intended answer.

### 7.3 Routes

Added to the existing `OrganisationController` (`@Controller('admin/organisation')`,
`apps/api/src/organisation/organisation.controller.ts:46-121`), following its idiom exactly:
`@RequirePermissions(...)`, `@contractVersion()`, and `@Body(new ZodBodyPipe(schema))`.

| Route | Permission |
|---|---|
| `GET /admin/organisation/tax-countries` | `organisation.read` |
| `POST /admin/organisation/tax-countries` | `organisation.write` (201) |
| `PATCH /admin/organisation/tax-countries/:code` | `organisation.write` |
| `PUT /admin/organisation/tax-countries/:code/availability` | `organisation.write` |
| `GET /admin/organisation/tax-countries/:code/changes` | `organisation.read` |

`deposit_bp` needs no route of its own: it joins the existing `GET`/`PUT
/admin/organisation` profile payload.

One **public, unauthenticated** read is also required, because the storefront's country select
must be populated before the customer has any identity or any order:

| | |
|---|---|
| Path | `GET /destinations` — deliberately **not** under `/admin` |
| Guard | `@AllowAnonymous`, the decorator the storefront's other public reads use |
| Returns | `code` and `name_th` for active rows, ordered by `sort_order`. **Nothing else** — no rate, no treatment, no basis |
| Route audit | one line in `apps/api/tests/rbac/route-audit.test.ts` as `GET /destinations [anonymous]` |
| Admin route table | **absent** from `ADMIN_ROUTE_PERMISSIONS`, whose selector matches `/admin` paths only — which is why the path must not be under `/admin` |

**This has no precedent in P1, and the earlier draft of this spec claimed otherwise by reading
a citation backwards.** P1 chose `GET orders/:orderId/payment-instructions` *instead of* a
public list, and the sentence *"There is no need to publish account numbers to callers with no
order"* is P1's argument **against** publication
(`docs/superpowers/specs/2026-08-09-organisation-settings-and-customer-slip-design.md:246-250`).

The public read is justified on its own terms instead. A country's name is not confidential —
it is the set of places the company sells to, which any customer discovers by asking. What P1
withheld was *account numbers*, and this route withholds the analogous thing: the rate, the
treatment and the basis, which are tax policy and belong on the quotation the customer has
actually received. The order-scoping P1 chose is unavailable here by construction: the customer
must pick a destination *before* an order exists.

### 7.4 Three test tables that will fail

Each is an exhaustive `toStrictEqual` list. None of them is optional, and all three fail for
reasons that look unrelated to tax:

- `apps/api/tests/admin/route-permissions.test.ts` — `ADMIN_ROUTE_PERMISSIONS` map, which
  lists the seven organisation routes at `:137-143`; the assertion at `:164-175` compares key
  sets both ways.
- `apps/api/tests/rbac/route-audit.test.ts` — a sorted whole-app route inventory; each new
  endpoint needs a literal line in the right sorted position with its access kind in brackets
  (existing organisation entries at `:293-295`, `:389`, `:398`, `:470-471`).
- `apps/dashboard/tests/navigation.test.ts` — asserts exact href lists per permission set and
  that hrefs are unique (`:92-96`).

The dashboard's hand-maintained permission copy at
`apps/dashboard/src/lib/auth/permissions.ts:27-47` needs **no change**, because P2 adds no
permission code. It is nonetheless worth knowing that
`apps/api/tests/rbac/permission-parity.test.ts` now guards it by regex over the file text —
`//` line comments are *not* stripped (`:29`), so writing `// mirrors 'tax.read'` in that file
would fail the API suite.

### 7.5 Dashboard

The tax-country table joins the existing `/organisation` page
(`apps/dashboard/src/app/(app)/organisation/page.tsx`, titled ข้อมูลบริษัท, already in the
ระบบ nav section at `apps/dashboard/src/lib/nav/navigation.ts:213-224`). No new route, so no
new nav entry — which also avoids the one gap in the nav guarantee: `typedRoutes: true` makes
an entry pointing at a missing page a compile error, but **a page with no entry ships
silently**, the failure `navigation.ts:50-53` records for `/quotes`.

The form follows `organisation-screen.tsx` exactly: `'use client'`, a per-section
discriminated union (`{status:'loading'} | {status:'failed'} | {status:'ready'}`), the
`baseline !== initial` re-seed derived during render rather than in a `useEffect` (`:144-165`),
`editable = can('organisation.write')` gating the save button, and re-fetch on save rather
than optimistic update.

---

## 8. What the customer and staff see

### 8.1 The quotation gains a basis-aware layout

For an exclusive country the layout is unchanged. For an inclusive country, per D5:

```
1. เก้าอี้อะลูมิเนียม        × 2      20,000.00     ← the catalogue price
2. โต๊ะอะลูมิเนียม          × 1      10,000.00     ← the catalogue price
───────────────────────────────────────────────
ยอดก่อนภาษี                          27,522.94
VAT 9% (รวมอยู่ในราคาแล้ว)             2,477.06
ยอดรวมที่ต้องชำระ                     30,000.00
```

The line and charge amounts together sum to the grand total; net and VAT are the breakdown
beneath. The rejected alternative —
scaling each line down to its net share — was rejected on arithmetic, not taste: 20 000/1.09
and 10 000/1.09 round to 18 348.62 and 9 174.31, summing to 27 522.93 against a document net
of 27 522.94. A one-satang discrepancy on a document a customer reconciles is a document
nobody can sign, and it is the same failure `vat.ts:61-63` already cites as the reason
`fromGrand` subtracts rather than multiplies.

One new i18n key, `quotation.vatIncluded` → `รวมอยู่ในราคาแล้ว`, rendered only when
`taxBasis === 'inclusive'`. Eight locales.

`QuotationIsland.tsx:272` and the staff sheet at
`apps/dashboard/src/components/quotes/quotation-sheet.tsx:302` both change, together. They are
two renderings of one document; if only one learns the inclusive layout, staff and customer
hold papers that disagree.

### 8.2 The storefront's VAT claims are removed

D6. The storefront is prerendered — `revalidate = false`, `dynamicParams = false`
(`apps/web/src/app/[locale]/layout.tsx:33-34`, `:85`) — so a rate is baked into the HTML at
build time. That is harmless today because nobody can change the rate. **After P2 the admin
can**, and a prerendered "VAT 7%" becomes a false statement the moment they do. Reading a
country from `searchParams` is not an escape: on `products/[slug]` it would silently opt all
648 prerendered pages out of static rendering with no error
(`products/[slug]/page.tsx:43-49`).

The honest resolution is that a page which cannot know the tax should not assert it. Tax
belongs to the quotation, which is per-destination and data-driven.

Exact inventory. Deleted from `keys.ts` and all eight catalogues:

| Key | Current Thai | Render sites |
|---|---|---|
| `price.vatExcluded` | `ราคายังไม่รวม VAT 7%` | `[locale]/page.tsx:155`, `AppFooter.tsx:178`, `QuoteScreen.tsx:180`, `ConfiguratorIsland.tsx:611` |
| `price.vatExcludedShort` | `ยังไม่รวม VAT` | `QuoteScreen.tsx:328` — **one site only** |
| `home.pricing.excluded.vat` | `VAT 7%` | `[locale]/page.tsx:301` |
| `about.fact.startingPrice.note` | `ยังไม่รวม VAT 7%` | `about/page.tsx:190` |

Renamed, because the name would otherwise lie:

| From | To | New Thai |
|---|---|---|
| `summary.areaAndVat` | `summary.area` | `(p, f) => \`${f.area(p.areaSqUm)} ตร.ม.\`` — Thai only; see below |

That rename is **not** mechanical. It is a parameterised key (`keys.ts:190` —
`{ areaSqUm: bigint }`), so the replacement must stay a function entry in all eight catalogues,
and each of the other seven embeds the VAT clause **inside** the same interpolation — e.g.
`zh.ts:194` is `` (p, f) => `${f.area(p.areaSqUm)} m² · 价格不含 7% 增值税` ``. Seven non-Thai
replacement strings must therefore be authored, not copied. Its single render site is
`PriceSummary.tsx:131`.

Added: `quotation.vatIncluded` (§8.1).

Kept: `quotation.vat` (`ภาษีมูลค่าเพิ่ม`) — a label on the quotation, whose rate is
data-driven from the pinned document. `home.pricing.excluded.title` (`ราคานี้ยังไม่รวม`) —
after `…excluded.vat` is deleted the list still holds `install`, `delivery` and `removal`
(`page.tsx:299-306`), so the heading remains true and the block survives.

Catalogue churn: 4 keys deleted × 8 locales = 32 entries removed; 1 key renamed × 8 = 8
edited; 1 key added × 8 = 8 written. 48 catalogue entries, plus `keys.ts`.

Two structural consequences the plan must handle rather than discover:

- **`about/page.tsx`'s `Fact` takes `note: string` as a required prop** (`:313`) and renders it
  unconditionally in a `<span>` (`:320`). Removing the note means `note?: string` plus a guard,
  not merely deleting the argument.
- **`AppFooter` is on only three of the eight storefront routes** —
  home, `/products`, `/about` (`footer-routes.ts:32-34`, gated at `AppShell.tsx:88`). Treating
  the footer as the global fix leaves `/quote` and the product pages untouched, which is
  precisely why `QuoteScreen.tsx:180` and `ConfiguratorIsland.tsx:611` render their own copies.

### 8.3 Left alone deliberately

Named here so a reviewer can see they were considered, not missed.

- **`order-detail.tsx:205`** shows `ภาษีมูลค่าเพิ่ม` with no rate at all. Nothing to correct.
- **`templates.ts:127`** (order-received email) says tax was recorded *as the customer saw it*
  and quotes no rate. Still true.
- **`vatLabelTh`** (`quote-alerts.tsx:205-219`) is already treatment-aware and rate-driven.
- **Treatment wording for the customer.** `zero_rated`, `exempt` and `out_of_scope` continue
  to print as a rate — for a Thai export invoice "VAT 0%" is correct wording, and writing
  defensible tax language in Lao, Burmese and Hindi is beyond what this round can warrant.
  `vatLabelTh` remains staff-facing and Thai-only.

---

## 9. Erasure

Three new foreign keys to `users.id` arrive at once: `tax_countries.updated_by_user_id`,
`tax_country_changes.changed_by_user_id`, `organisation_profile_changes.changed_by_user_id`.
All three take treatment **`scrub`**, matching P1's three entries at
`packages/db/src/schema/auth.ts:464-466`.

Four mechanics, each of which has already bitten this repo:

1. **The coverage test reads `information_schema`**, so the *migration alone* trips it even if
   the Drizzle TypeScript is never touched (`packages/db/tests/erasure.test.ts:663-682`).
2. **The assertion runs both ways.** Declaring a treatment before the migration creates the FK
   fails with *"a treatment names a foreign key that no longer exists"* (`:682`). Migration and
   treatments ship in one change; treatments-first is a red build.
3. **`scrub` has no generic coverage.** The coverage loop does `if (treatment !== 'delete')
   continue;` (`:707`), so declaring `scrub` and forgetting the UPDATE in `erase_user()` is
   silent repo-wide — the test file records that commenting out a real scrub left all 148
   package tests and all 721 API tests green. Each new scrub column therefore needs **its own
   named test** *and* **a seeded row in `createSubject`**, or the test counts zero either way
   and passes vacuously (`:145-151`).
4. **`erase_user()` cannot be patched incrementally.** Any change re-emits the whole ~194-line
   body under `CREATE OR REPLACE FUNCTION`, carried verbatim from `pg_proc.prosrc`, plus the
   new statements — the technique and its warning are in
   `packages/db/drizzle/0028_erase_organisation_actors.sql`. Writing NULL into an append-only
   history table needs `SET LOCAL session_replication_role = replica`, which is
   **transaction-scoped, not statement-scoped**: 0028 resets it to `origin` on the very next
   line, and its comment records that the bypass also disables the FK-integrity trigger for
   the duration — harmless there only because the written value is a literal NULL.

---

## 10. Migration mechanics

`pnpm db:generate --custom` **does not diff the schema.** It writes a snapshot that is a copy
of the previous snapshot with a new uuid (drizzle-kit 0.31.10, `bin.cjs:19855-19860` and
`:32176-32186`). Adding tables to `src/schema` and then generating `--custom` leaves the chain
believing they do not exist, and a later plain `db:generate` re-emits `CREATE TABLE` for them.

This repo's convention for hand-written migrations is therefore **a journal entry plus the
`.sql` file, with no snapshot at all** — as 0022, 0024, 0025 and 0028 already do (29 `.sql`
files against 25 snapshots). `readMigrationFiles` reads only `_journal.json` and `<tag>.sql`,
and tolerates the absence. A journal entry without its `.sql` file, however, fails global test
setup — the two must land together.

**There are three databases, and only one needs migrating by hand.**

| Database | Used by | Migration |
|---|---|---|
| `wewin` | dev, from `.env` | **`pnpm db:migrate`, manually** |
| `wewin_api_test` | the ~721 `apps/api` tests (`apps/api/tests/test-db.ts:25`) | dropped, re-created and migrated by its own `globalSetup` on every run |
| `wewin_db_test` | the `packages/db` tests (`packages/db/tests/test-db.ts:15`) | same |

`packages/db/src/test-database.ts:90-104` does the `drop database … with (force)` / `create
database` / `migrate(...)` cycle, called from both `globalSetup` files. So a hand-run migration
against either test database is wasted work, and a forgotten one is harmless.

`wewin` is the one that bites. P1 shipped with `wewin` running a stale `erase_user()` because
drizzle had recorded the migration as applied before the file was corrected — the drop-and-recreate
that protects the test databases does not exist for the dev one.

---

## 11. Testing

Beyond the per-task TDD cycle, seven assertions carry this feature. Each is written to fail for
one reason.

1. **Round-trip survival.** Write a document carrying `destinationCountry` and `taxBasis`, read
   it back through `order.repository.ts`, assert both are present. Mutation test it by removing
   one field from `orderDocumentWireSchema` and confirming the test goes red — the silent-strip
   failure has no other detector.
2. **A legacy document still parses.** The version-bump tripwire, and it must **not** be written
   as "read every existing row and assert none 503s" — an earlier draft said exactly that and it
   asserts nothing. Every Postgres suite runs against a database that
   `packages/db/src/test-database.ts:90-104` drops, re-creates and re-migrates **empty** at the
   start of each run, so such a loop iterates zero rows and passes vacuously. This is the same
   hazard class §9 item 3 records for erasure's row-count loops. Write it instead as a
   **hand-built legacy fixture**: a document literal carrying the current
   `documentSchemaVersion` and **no** `destinationCountry` or `taxBasis`, parsed through
   `orderDocumentWireSchema` and then through `decodeDocumentRow`, asserting success. The 21
   real rows in `wewin` get a **one-off manual read before merge**, recorded in the plan as a
   human step, because no automated suite can see them.
3. **Inclusive foots.** For a country at 9% inclusive, assert on one document that
   `sum(lines) + sum(charges) == grandTotal` and `net + vat == grandTotal`. **Both arrays**:
   `lines` and `charges` are separate in the document (`packages/contract/src/order.ts:313-314`)
   and under inclusive the grand total is the sum of both, so a lines-only assertion is false
   for any quote carrying a charge. The fixture must include at least one exempt charge, or the
   assertion proves nothing about the case that can break. Today only the second equality is
   constrained, by `order_documents_total_foots`.
4. **A deposit at policy is not a concession.** With `deposit_bp = 3000`, build the schedule
   from `depositPercentTerms(3000)` and assert `cashflowConcessionMinor(total, rows, 3000)`
   is `0n`, and that a submit through the real gate completes. Then assert that a schedule
   gating only 2000 bp, measured against the same 3000 bp floor, returns a **non-zero**
   concession — the control moved, it did not vanish. Mutation test by reverting
   `concession.ts:365` to two arguments: the submit test must go red, because the floor
   silently returns to 10 000 bp.
5. **Unknown refuses; withdrawn does not.** Two assertions, because §5.1 draws a line between
   them and a single test would hide it. An **unknown** code refuses the submit rather than
   pinning Thai VAT on a foreign sale (§5.1 step 3). An **inactive** code resolves and submits
   normally (§5.1 step 2) — the test that proves an admin withdrawing a country does not brick
   carts already carrying it.
6. **Catalogue completeness.** `apps/web/src/i18n/catalogue.test.ts:446` already asserts
   `coverageOf(locale) === 1` for all eight. Deleting keys and adding one must leave it green;
   `th.ts` is typed `UiCatalogue` so a missing key there is a compile error, while the other
   seven are `PartialUiCatalogue` and fail only in that test.
7. **A basis change does not move a margin measurement.** Referenced by §5.2 edit D, which leaves
   `concession.ts:195`/`:332` exclusive-only. Measure the margin dimension for one document under
   `exclusive`, then under `inclusive` with everything else identical, and assert the measurement
   is unchanged — the claim that a uniform per-line basis cancels out of a difference between two
   states. If it does move, edit D is wrong and those two sites must become basis-aware.

Money is `bigint` minor units throughout. P1's final review found a sign-split bug where
`-150n` rendered as `-1.-50` because BigInt truncates toward zero; any new money rendering in
P2 uses the corrected `f.baht`/sign-split form rather than a fresh division.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| A required field reaches the pinned document and 503s all 21 quotations. | Both new fields are optional; test 2 in §11 is the tripwire. |
| A field is written to the JSON but never declared, and is silently stripped forever. | Test 1, with its mutation check. No other detector exists — there is no read-time hash verification. |
| The deposit ships without the `concession.ts` edit and every submit rolls back. | Test 4, and the two changes are specified as one deliverable, not two tasks. |
| Lines and charges stop summing to the printed grand total under inclusive pricing. | Test 3, with a fixture that carries a charge. No database constraint covers this — `order_documents_total_foots` checks only `grand = net + vat`. |
| The quote screen shows exclusive money while the pinned document is inclusive. | §5.2 edit C — all five `effective()` call sites. This is the divergence `order-document.ts:254` exists to prevent. |
| Every inclusive quote displays a phantom concession, which the fail-closed gate then measures. | §5.2 edit B — `overrides.ts:268`, the baseline branch, takes the same switch as `:224`. |
| The rate stays 700 bp for every country because only the formula was changed. | §5.2 edit A — `orders.service.ts:721` and `:747-748`. Without it the feature is cosmetic. |
| The shipped default deposit silently changes the schedule's shape and reddens a passing test. | §5.3 edit G — `deposit_bp === 10_000` keeps today's pay-in-full terms; `lifecycle.pg.test.ts:188` stays green. |
| A schedule mismatch surfaces as an untargeted 409 at COMMIT. | VAT must be final before `pinsForSubmit`; the ordering is stated at `orders.service.ts:769-772`, and the schedule's constraints are DEFERRED (`schedule.repository.ts:28-33`). |
| A new optional contact field silently erases a value the cart already held. | `orderContactRequestSchema` is `.strictObject().refine(...)` — a `ZodEffects`, so it cannot be `.extend()`ed; the object literal and the `OrderContactRequestWire` interface are both edited. The service reads contact fields as `body.contact.X ?? order.contactX` (`orders.service.ts:780-790`) and the destination field follows that same pattern. |
| Storefront ships the country select before the contract accepts it. | Both submit schemas are `strictObject`, so an undeclared key is a 400, not an ignored field (`transitions.ts:100-104`). Contract before storefront, in that order. |

---

## 13. Explicitly not built

- **No approval UI and no `authority_limits` seeding — so a below-policy deposit stays
  unauthorable.** D2 removes the need for approval on a deposit **at** policy; it deliberately
  keeps the requirement below policy ("the control moves, it does not disappear"). With
  `authority_limits` empty and `quotes.approve` granted to no group, "requires approval" is in
  practice "is refused, and rolls back the whole submit". P2 therefore ships a company deposit
  policy that works, and leaves per-quotation deviation from it as impossible as it is today —
  neither better nor worse. §11 test 4 asserts the measurement, not that the submit succeeds.
  The dashboard screen for setting authority ceilings remains unbuilt.
- **No per-destination receiving bank account.** P1 recorded a cross-phase expectation at
  `2026-08-09-…-design.md:249` — *"P2 makes accounts vary by destination country, which this
  shape absorbs without changing the endpoint"* — and used it to justify order-scoping
  `GET orders/:orderId/payment-instructions`. P2 does not deliver it: there is no link between
  `tax_countries` and `bank_accounts`, and no destination input to the payment-instructions
  read. The endpoint's shape still absorbs it later, exactly as P1 argued, so nothing is
  foreclosed — but the commitment is deferred rather than met, and is recorded here so it is not
  quietly lost a second time.
- **No per-country deposit.** D4 chose one company-wide number.
- **No tax-zone indirection.** Countries carry their own rules. A zone abstraction earns its
  place when several countries share a rule; with one seeded row it would be structure without
  a fact behind it.
- **No effective-dating of rates.** A rate change applies from the moment it is saved.
  Historical rates are recoverable from the pinned documents and from
  `tax_country_changes`.
- **No currency.** Money stays `THB.satang` end to end. A destination country changes the tax,
  not the unit.
- **No customer-facing treatment wording** beyond the rate (§8.3).
- **No backfill of the 21 existing documents.** Impossible by trigger, and asserting a
  destination for 21 real contracts never quoted under one would invent a business fact.
