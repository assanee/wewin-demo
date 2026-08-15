import type { CreateProductRequestWire, DraftOptionWire, DraftRuleWire } from '@wewin/contract/admin';
import type { ProductWire } from '@wewin/contract/catalog';

/**
 * ⭐ Adding a product — the part that is arithmetic rather than a screen.
 *
 * ── Why a new product starts from an old one ─────────────────────────────────────
 *
 * `POST /admin/catalog/products` has existed since the catalogue did, and `createProduct`
 * has been sitting in `catalog-api.ts` unimported for as long. What was missing is not the
 * call — it is that **the contract will not accept a sparse product**. `productWireSchema`
 * demands `groups: […].min(1)`, and `productFieldsWireSchema` demands a whole `elevation`:
 * how many panels, which way they open, glass or louvre or mesh. There is no such thing as
 * an empty product to fill in later, so a create form that starts from a blank page has to
 * ask for sixteen fields before it can ask for a name.
 *
 * The catalogue itself says what to do instead. Its 81 products are built from ten group
 * factories — a new บานเลื่อน is the old บานเลื่อน with a different panel count, and it
 * carries the same colour swatches, the same width and height bounds, the same rules. So
 * this takes a source product and changes only what must differ, which is the identity:
 * `id`, `slug`, `skuPrefix`, and the name a person reads.
 *
 * The side effect is that ทำสำเนาสินค้า — which the catalogue screen also never had — is
 * the same feature, and not a second one.
 *
 * ⚠️ **What this does not solve.** After creating, the draft editor can change fields but
 * still cannot add or remove an option group: `putOption` and `deleteOption` are in the
 * client and no screen imports them either. So a new product's option *shape* is whatever
 * its source had. Choosing a source with the right groups is currently the only way to get
 * them, and that is a real limitation rather than a design.
 */

/** What a person types. Everything else is inherited. */
export interface NewProductIdentity {
  readonly id: string;
  readonly slug: string;
  readonly skuPrefix: string;
  readonly nameTh: string;
}

/** Enough of a product row to check a new identity against. */
export interface ExistingProduct {
  readonly id: string;
  readonly slug: string;
  readonly skuPrefix: string;
}

/*
 * Copied from `packages/contract/src/admin.ts` rather than imported, because the schemas
 * there are not exported individually and a `safeParse` of the whole request would answer
 * "invalid" for a field the person has not reached yet. These are the same four rules; the
 * server is still the one that decides, and `create-product-dialog` shows what it says.
 */
const ID_SHAPE = /^[a-z0-9-]+$/;
const SKU_PREFIX_SHAPE = /^[A-Z0-9]+$/;

/**
 * Every reason this identity would be refused, in the order a person fills the form.
 *
 * All of them, not the first — a form that reveals one problem per attempt is a form people
 * fill in four times. Empty means nothing is known to be wrong here, which is not the same
 * as "the server will accept it": `id`, `slug` and `skuPrefix` are unique in the database
 * and this list is only as complete as the products the screen has loaded.
 */
export function identityProblems(
  identity: NewProductIdentity,
  existing: readonly ExistingProduct[],
): readonly string[] {
  const problems: string[] = [];
  const id = identity.id.trim();
  const slug = identity.slug.trim();
  const skuPrefix = identity.skuPrefix.trim();
  const nameTh = identity.nameTh.trim();

  if (id.length === 0) problems.push('ต้องมีรหัสสินค้า');
  else if (id.length > 64) problems.push('รหัสสินค้ายาวเกิน 64 ตัวอักษร');
  else if (!ID_SHAPE.test(id)) problems.push('รหัสสินค้าใช้ได้เฉพาะ a-z, 0-9 และ - เท่านั้น');
  else if (existing.some((p) => p.id === id)) problems.push(`มีสินค้ารหัส ${id} อยู่แล้ว`);

  if (slug.length === 0) problems.push('ต้องมีสลัก');
  else if (slug.length > 64) problems.push('สลักยาวเกิน 64 ตัวอักษร');
  else if (!ID_SHAPE.test(slug)) problems.push('สลักใช้ได้เฉพาะ a-z, 0-9 และ - เท่านั้น');
  else if (existing.some((p) => p.slug === slug)) problems.push(`มีสินค้าที่ใช้สลัก ${slug} อยู่แล้ว`);

  if (skuPrefix.length === 0) problems.push('ต้องมีคำนำหน้า SKU');
  else if (skuPrefix.length > 16) problems.push('คำนำหน้า SKU ยาวเกิน 16 ตัวอักษร');
  else if (!SKU_PREFIX_SHAPE.test(skuPrefix)) {
    problems.push('คำนำหน้า SKU ใช้ได้เฉพาะ A-Z และ 0-9 ตัวพิมพ์ใหญ่');
  } else if (existing.some((p) => p.skuPrefix === skuPrefix)) {
    /*
     * ⚠️ A warning that reads like an error, deliberately. Two products sharing a prefix is
     * legal in the database and produces SKUs that differ only in the option codes after it
     * — which is exactly the collision a person cannot see on a packing list.
     */
    problems.push(`คำนำหน้า SKU ${skuPrefix} ถูกใช้กับสินค้าอื่นแล้ว — รหัส SKU จะชนกัน`);
  }

  if (nameTh.length === 0) problems.push('ต้องมีชื่อสินค้า');

  return problems;
}

/**
 * A source product plus a new identity, as the request the API takes.
 *
 * ⚠️ `sortOrder` is the array index, and that is the whole reason this function exists
 * rather than a spread at the call site. `ProductWire.groups` is an ordered array and
 * `CreateProductRequestWire.options` is a record keyed by group code — a record has no
 * order, so the position has to be carried across explicitly or the new product's
 * configurator asks for the colour before the width.
 */
export function createRequestFrom(
  source: ProductWire,
  identity: NewProductIdentity,
): CreateProductRequestWire {
  const options: Record<string, DraftOptionWire> = {};
  source.groups.forEach((group, index) => {
    options[group.code] =
      group.kind === 'sku'
        ? {
            kind: 'sku',
            sortOrder: index,
            valueCodes: group.values.map((value) => value.code),
            defaultValueCode: group.defaultValue,
          }
        : {
            kind: 'custom',
            sortOrder: index,
            minUm: group.minUm,
            maxUm: group.maxUm,
            stepUm: group.stepUm,
            defaultUm: group.defaultUm,
          };
  });

  const rules: Record<string, DraftRuleWire> = {};
  source.rules.forEach((rule, index) => {
    rules[rule.id] = {
      severity: rule.severity,
      messageTh: rule.messageTh,
      when: rule.when,
      sortOrder: index,
    };
  });

  return {
    id: identity.id.trim(),
    slug: identity.slug.trim(),
    skuPrefix: identity.skuPrefix.trim(),
    fields: {
      nameTh: identity.nameTh.trim(),
      categoryId: source.categoryId,
      summaryTh: source.summaryTh,
      heroImage: source.heroImage,
      leadTimeDays: source.leadTimeDays,
      pricePerSqm: source.pricePerSqm,
      minBillableSqUm: source.minBillableSqUm,
      elevation: source.elevation,
    },
    /*
     * `rules` is optional on the wire and an empty record is not the same as absent — the
     * server distinguishes "no rules" from "rules unspecified". Most products have none.
     */
    ...(source.rules.length === 0 ? {} : { rules }),
    options,
  };
}

/**
 * What a person is about to inherit, as one Thai sentence for the dialog.
 *
 * The dialog cannot show the whole document, and a person choosing a source is deciding
 * about exactly three things: which category it lands in, how many option groups come with
 * it, and whether any rules follow. Anything else they can see on the source's own page.
 */
export function inheritanceSummaryTh(source: ProductWire): string {
  const groups = `${String(source.groups.length)} ชุดตัวเลือก`;
  const rules = source.rules.length === 0 ? 'ไม่มีกฎ' : `${String(source.rules.length)} กฎ`;
  const panels = `${String(source.elevation.panels)} บาน`;
  return `${panels} · ${groups} · ${rules}`;
}
