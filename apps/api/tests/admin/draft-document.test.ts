import { describe, expect, it } from 'vitest';

import type { Elevation } from '@wewin/core';
import { toDocument } from '@wewin/db/compile';
import { documentHash } from '@wewin/db/hash';
import { products as fixtureProducts } from '@wewin/core/fixtures';

import { AppError } from '../../src/common/errors/app-error';
import {
  availabilityOf,
  compileDraft,
  compileDraftDocument,
  type DraftOptionRow,
  type DraftRows,
} from '../../src/admin/draft-document';

/**
 * The compiler, tested against the one thing it has to agree with: the seed.
 *
 * `packages/db`'s `toDocument` builds a document out of the TS catalogue table. This
 * builds one out of the normalised rows. They are two different functions reading two
 * different representations, and the whole two-layer design of plan 5 rests on them
 * producing the *same document* — because the storefront reads what the seed wrote today
 * and will read what the dashboard wrote tomorrow, and a difference between them is a
 * silent repricing on the first republish of an untouched product.
 *
 * So the first block below takes a real fixture product, turns it into the rows the
 * database would hold for it, compiles those rows, and asserts the digest matches
 * `documentHash(toDocument(product))`. Not a field comparison — the digest, which is the
 * value the configurator sends back and the value a 409 is decided on.
 */

const elevation: Elevation = { panels: 1, operation: 'fixed', infill: 'glass' };

/** The rows Postgres would hold for a fixture product, built by hand from the fixture. */
function rowsFor(productId: string): DraftRows {
  const product = fixtureProducts.find((candidate) => candidate.id === productId);
  if (!product) throw new Error(`no fixture product "${productId}"`);

  const options: DraftOptionRow[] = product.groups.map((group, index) => {
    if (group.kind === 'sku') {
      return {
        groupCode: group.code,
        kind: 'sku',
        labelTh: group.labelTh,
        input: group.input,
        includeInSkuCode: group.includeInSkuCode,
        authoredUnit: null,
        helperTh: null,
        sortOrder: index,
        defaultValueCode: group.defaultValue,
        minUm: null,
        maxUm: null,
        stepUm: null,
        defaultUm: null,
        values: group.values.map((value, valueIndex) => ({
          code: value.code,
          labelTh: value.labelTh,
          swatchHex: value.swatchHex ?? null,
          deltaType: value.delta.type,
          // Satang and basis points, as the columns hold them — the same conversion the
          // seed performs, which is why the digests can be compared at all.
          deltaMinor:
            value.delta.type === 'flat' || value.delta.type === 'per_sqm'
              ? BigInt(value.delta.amount) * 100n
              : null,
          deltaBp: value.delta.type === 'percent' ? value.delta.amount * 100 : null,
          available: value.available,
          sortOrder: valueIndex,
        })),
      };
    }

    return {
      groupCode: group.code,
      kind: 'custom',
      labelTh: group.labelTh,
      input: 'number',
      includeInSkuCode: false,
      authoredUnit: group.unit,
      helperTh: group.helperTh ?? null,
      sortOrder: index,
      defaultValueCode: null,
      minUm: group.minUm,
      maxUm: group.maxUm,
      stepUm: group.stepUm,
      defaultUm: group.defaultUm,
      values: [],
    };
  });

  return {
    product: {
      id: product.id,
      slug: product.slug,
      skuPrefix: product.skuPrefix,
      categoryId: product.categoryId,
      nameTh: product.nameTh,
      summaryTh: product.summaryTh,
      heroImage: product.heroImage,
      leadTimeMinDays: product.leadTimeDays[0],
      leadTimeMaxDays: product.leadTimeDays[1],
      pricePerSqmMinor: BigInt(product.pricePerSqm) * 100n,
      minBillableSqUm: product.minBillableSqUm,
      elevation: product.elevation,
      videoUrl: product.videoUrl ?? null,
    },
    options,
    /* ⭐ 0052. The fixtures carry none, which is the case the hash stability rests on. */
    images: [...(product.images ?? [])],
    rules: product.rules.map((rule, index) => ({
      code: rule.id,
      severity: rule.severity,
      messageTh: rule.messageTh,
      whenExpr: toDocument(product).rules[index]?.when ?? missing(rule.id),
      sortOrder: index,
    })),
  };
}

function missing(key: string): never {
  throw new Error(`fixture has no rule "${key}"`);
}

describe('compiling a draft from its rows', () => {
  it('produces the same document the seed writes, for every fixture product', () => {
    for (const product of fixtureProducts) {
      const fromRows = compileDraftDocument(rowsFor(product.id));
      expect(documentHash(fromRows), product.id).toBe(documentHash(toDocument(product)));
    }
  });

  it('never puts stock inside the document', () => {
    const rows = rowsFor('lvr-adj');
    const withOneSoldOut: DraftRows = {
      ...rows,
      options: rows.options.map((option) => ({
        ...option,
        values: option.values.map((value, index) => ({ ...value, available: index !== 0 })),
      })),
    };

    /*
     * Plan 5 point 2 and `product_versions_document_has_no_availability`, checked in the
     * compiler rather than only at the write. Taking a colour out of stock must not change
     * a byte of the document — if it did, the freeze would make stock unchangeable for
     * every published product.
     */
    expect(documentHash(compileDraftDocument(withOneSoldOut))).toBe(
      documentHash(compileDraftDocument(rows)),
    );
    expect(JSON.stringify(compileDraftDocument(withOneSoldOut))).not.toContain('available');
  });

  it('overlays stock onto the preview it returns, without touching the document', () => {
    const rows = rowsFor('lvr-adj');
    const soldOut: DraftRows = {
      ...rows,
      options: rows.options.map((option) => ({
        ...option,
        values: option.values.map((value) => ({ ...value, available: false })),
      })),
    };

    const compiled = compileDraft(soldOut);
    const skuGroups = compiled.product.groups.filter((group) => group.kind === 'sku');
    expect(skuGroups.length).toBeGreaterThan(0);
    expect(skuGroups.every((group) => group.values.every((value) => !value.available))).toBe(true);
  });

  it('answers "not sellable" for a value the draft does not offer', () => {
    // Absent means no, for the same reason the read path says so: a value with no row is
    // one this version does not offer, and `true` would put it on a screen.
    expect(availabilityOf(rowsFor('lvr-adj'))('profile_color', 'NOT_A_COLOUR')).toBe(false);
  });
});

describe('a draft that core would refuse', () => {
  const refuse = (rows: DraftRows): AppError => {
    try {
      compileDraft(rows);
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
    throw new Error('expected compileDraft to refuse these rows');
  };

  it('refuses a product with no width group', () => {
    const rows = rowsFor('lvr-adj');
    const error = refuse({
      ...rows,
      options: rows.options.filter((option) => option.groupCode !== 'width'),
    });

    // 422 and not 400: the request was well-formed and the catalogue it describes is not,
    // which is the distinction a dashboard needs to decide what to show a user.
    expect(error.status).toBe(422);
    expect(JSON.stringify(error.details)).toContain('width');
  });

  it('refuses a default that is not one of the values offered', () => {
    const rows = rowsFor('lvr-adj');
    const error = refuse({
      ...rows,
      options: rows.options.map((option) =>
        option.kind === 'sku' ? { ...option, defaultValueCode: 'NOT_OFFERED' } : option,
      ),
    });

    expect(error.status).toBe(422);
  });

  it('refuses a step off the 25 µm lattice', () => {
    const rows = rowsFor('lvr-adj');
    const error = refuse({
      ...rows,
      options: rows.options.map((option) =>
        option.groupCode === 'width' ? { ...option, stepUm: 30n } : option,
      ),
    });

    expect(error.status).toBe(422);
  });

  it('refuses a rule that names a group the draft does not offer', () => {
    const rows = rowsFor('lvr-adj');
    const error = refuse({
      ...rows,
      rules: [
        {
          code: 'probe-unknown-group',
          severity: 'error',
          messageTh: 'กฎที่อ้างกลุ่มที่ไม่มี',
          whenExpr: { op: 'selected', group: 'not_a_group', value: 'X' },
          sortOrder: 0,
        },
      ],
    });

    /*
     * The same class of mistake `publishProductVersion` refuses at publish time, refused
     * here at *save* time. That is what makes publishing a pure ordering operation: a draft
     * in this state cannot be committed, so `unknown_referenced_group` is unreachable from
     * the admin surface even though it is still mapped.
     */
    expect(error.status).toBe(422);
    expect(JSON.stringify(error.details)).toContain('not_a_group');
  });

  it('refuses an elevation whose moving panel does not exist', () => {
    /*
     * The cross-field check `@wewin/contract`'s wire schema deliberately does not make —
     * see the note beside it in `packages/contract/tests/admin.test.ts`. A panel index past
     * the end of the elevation draws nothing, and this is the layer that catches it, on the
     * edit, rather than at render time in a customer's browser.
     */
    const rows = rowsFor('lvr-adj');
    const error = refuse({
      ...rows,
      product: {
        ...rows.product,
        elevation: { panels: 2, operation: 'slide', infill: 'glass', movingPanels: [5] },
      },
    });

    expect(error.status).toBe(422);
    expect(JSON.stringify(error.details)).toContain('movingPanels');
  });

  it('refuses a price that is not a whole baht', () => {
    const rows = rowsFor('lvr-adj');
    const error = refuse({
      ...rows,
      product: { ...rows.product, pricePerSqmMinor: 150001n },
    });

    // `calcPrice` reaches `BigInt(product.pricePerSqm)` and would throw on ฿1,500.01, so a
    // fraction here is a price the server cannot honour. `products_price_whole_baht` says
    // the same thing one layer down; this is the layer that can name the field.
    expect(error.status).toBe(422);
    expect(error.message).toContain('ร่างนี้ยังบันทึกไม่ได้');
  });
});

describe('the digest is stable', () => {
  it('does not depend on how the rows were built', () => {
    const rows = rowsFor('lvr-adj');
    const rebuilt: DraftRows = {
      product: { ...rows.product },
      options: rows.options.map((option) => ({ ...option, values: [...option.values] })),
      rules: rows.rules.map((rule) => ({ ...rule })),
      images: [...rows.images],
    };

    // The hash is what a storefront compares to decide whether it is stale, so two
    // compiles of one draft producing two digests would fire 409s at customers who are
    // looking at exactly the right document.
    expect(documentHash(compileDraftDocument(rebuilt))).toBe(
      documentHash(compileDraftDocument(rows)),
    );
  });

  it('changes when a surcharge changes', () => {
    const rows = rowsFor('lvr-adj');
    const dearer: DraftRows = {
      ...rows,
      options: rows.options.map((option) =>
        option.kind === 'sku' && option.values.length > 0
          ? {
              ...option,
              values: option.values.map((value, index) =>
                index === 0 ? { ...value, deltaType: 'flat' as const, deltaMinor: 50000n, deltaBp: null } : value,
              ),
            }
          : option,
      ),
    };

    expect(documentHash(compileDraftDocument(dearer))).not.toBe(
      documentHash(compileDraftDocument(rows)),
    );
  });

  it('is not the elevation blob\'s key order', () => {
    const rows = rowsFor('lvr-adj');
    const reordered: DraftRows = {
      ...rows,
      // jsonb does not preserve key order, so a document read back from Postgres has its
      // own. `canonicalJson` sorts before hashing, and this is that promise held to.
      product: {
        ...rows.product,
        elevation: { infill: elevation.infill, operation: elevation.operation, panels: elevation.panels },
      },
    };
    const straight: DraftRows = {
      ...rows,
      product: { ...rows.product, elevation },
    };

    expect(documentHash(compileDraftDocument(reordered))).toBe(
      documentHash(compileDraftDocument(straight)),
    );
  });
});
