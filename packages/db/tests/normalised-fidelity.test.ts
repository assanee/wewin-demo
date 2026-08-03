import { beforeAll, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { OptionGroup, OptionValue, PriceDelta, Product } from '@wewin/core';
import { products as coreProducts } from '@wewin/core/fixtures';
import { bahtToMinor } from '@wewin/core/money';
import type { Database } from '../src/client.js';
import { referencedGroupCodes, toDocRule } from '../src/compile.js';
import { seedCatalog } from '../src/seed.js';
import {
  optionGroups,
  optionValues,
  productVersionOptionValues,
  productVersionOptions,
  productVersionRules,
  productVersions,
  products,
} from '../src/schema/index.js';
import { connect, describeDb } from './support/db.js';

/**
 * The *editable* layer holds the catalogue too.
 *
 * `seed.test.ts` reads the frozen document back and finds all 81 products in it — but
 * the document is compiled from `@wewin/core/fixtures` in the same function that writes
 * the rows, so it proves nothing about the rows. A seed that put `step_um` where
 * `default_um` belongs, or wrote a `per_sqm` surcharge as `flat`, would leave every
 * existing test green: nothing reads those columns yet.
 *
 * It stops being invisible in phase 4, when the dashboard edits these rows and the next
 * published document is compiled *from* them. Then a column that was wrong from the day
 * of the migration becomes a price. This file reconstructs each product from the
 * normalised tables alone — no `document` column is read anywhere in it — and compares
 * the result to the fixture table.
 */

const MINOR_PER_BAHT = 100n;

/**
 * Everything but the rules.
 *
 * The predicate stays an AST in jsonb by design (plan section 5), so it is compared in
 * the form it is stored in — see the second test — rather than decoded back into a `Rule`
 * just so this one can compare it. Splitting the product is honest about that; giving
 * `rebuild` a placeholder `when` would have been a lie the type system could not see.
 */
type ProductWithoutRules = Omit<Product, 'rules'>;

const withoutRules = (product: Product): ProductWithoutRules => {
  const { rules: _rules, ...rest } = product;
  return rest;
};

interface DeltaColumns {
  deltaType: 'none' | 'flat' | 'per_sqm' | 'percent';
  deltaMinor: bigint | null;
  deltaBp: number | null;
}

/** The columns back into the domain's `PriceDelta`, refusing anything they cannot mean. */
function toDelta(columns: DeltaColumns, where: string): PriceDelta {
  switch (columns.deltaType) {
    case 'none':
      return { type: 'none' };
    case 'percent': {
      const bp = columns.deltaBp;
      if (bp === null) throw new Error(`${where}: percent delta with no basis points`);
      return { type: 'percent', amount: bp / 100 };
    }
    case 'flat':
    case 'per_sqm': {
      const minor = columns.deltaMinor;
      if (minor === null) throw new Error(`${where}: ${columns.deltaType} delta with no amount`);
      return { type: columns.deltaType, amount: Number(minor / MINOR_PER_BAHT) };
    }
  }
}

describeDb('the normalised rows hold the catalogue, not only the document', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connect();
    await seedCatalog(db, 'test');
  });

  /**
   * One product, rebuilt from `products` + `product_version_options` +
   * `product_version_option_values` + `option_groups` + `option_values`.
   *
   * Deliberately the long way round, joining what an editor would edit, because the short
   * way is to read the document and the document is what this file exists not to trust.
   */
  async function rebuild(productId: string): Promise<ProductWithoutRules> {
    const [row] = await db.select().from(products).where(eq(products.id, productId));
    if (!row) throw new Error(`no product row for ${productId}`);

    const [version] = await db
      .select({ id: productVersions.id })
      .from(productVersions)
      .where(eq(productVersions.productId, productId));
    if (!version) throw new Error(`no version row for ${productId}`);

    const optionRows = await db
      .select({
        id: productVersionOptions.id,
        code: optionGroups.code,
        kind: optionGroups.kind,
        labelTh: optionGroups.labelTh,
        input: optionGroups.input,
        includeInSkuCode: optionGroups.includeInSkuCode,
        authoredUnit: optionGroups.authoredUnit,
        helperTh: optionGroups.helperTh,
        defaultValueCode: productVersionOptions.defaultValueCode,
        minUm: productVersionOptions.minUm,
        maxUm: productVersionOptions.maxUm,
        stepUm: productVersionOptions.stepUm,
        defaultUm: productVersionOptions.defaultUm,
      })
      .from(productVersionOptions)
      .innerJoin(optionGroups, eq(optionGroups.id, productVersionOptions.optionGroupId))
      .where(eq(productVersionOptions.productVersionId, version.id))
      .orderBy(asc(productVersionOptions.sortOrder));

    const groups: OptionGroup[] = [];
    for (const option of optionRows) {
      if (option.kind === 'sku') {
        const valueRows = await db
          .select({
            code: optionValues.code,
            labelTh: optionValues.labelTh,
            swatchHex: optionValues.swatchHex,
            deltaType: optionValues.deltaType,
            deltaMinor: optionValues.deltaMinor,
            deltaBp: optionValues.deltaBp,
            available: optionValues.available,
          })
          .from(productVersionOptionValues)
          .innerJoin(optionValues, eq(optionValues.id, productVersionOptionValues.optionValueId))
          .where(eq(productVersionOptionValues.productVersionOptionId, option.id))
          .orderBy(asc(productVersionOptionValues.sortOrder));

        const values: OptionValue[] = valueRows.map((value) => {
          const built: OptionValue = {
            code: value.code,
            labelTh: value.labelTh,
            delta: toDelta(value, `${productId}.${option.code}.${value.code}`),
            available: value.available,
          };
          // `exactOptionalPropertyTypes`: the column is nullable, the domain field is
          // absent-or-present, and writing `swatchHex: undefined` would compare unequal
          // to a fixture that simply has no such key.
          if (value.swatchHex !== null) built.swatchHex = value.swatchHex;
          return built;
        });

        if (option.input === 'number') throw new Error(`${option.code}: sku group with a number input`);
        if (option.defaultValueCode === null) throw new Error(`${option.code}: sku group with no default`);

        groups.push({
          kind: 'sku',
          code: option.code,
          labelTh: option.labelTh,
          input: option.input,
          required: true,
          includeInSkuCode: option.includeInSkuCode,
          values,
          defaultValue: option.defaultValueCode,
        });
        continue;
      }

      const { minUm, maxUm, stepUm, defaultUm, authoredUnit } = option;
      if (minUm === null || maxUm === null || stepUm === null || defaultUm === null) {
        throw new Error(`${option.code}: custom group with an empty bound`);
      }
      if (authoredUnit === null) throw new Error(`${option.code}: custom group with no authored unit`);

      const custom: OptionGroup = {
        kind: 'custom',
        code: option.code,
        labelTh: option.labelTh,
        input: 'number',
        unit: authoredUnit,
        minUm,
        maxUm,
        stepUm,
        defaultUm,
      };
      if (option.helperTh !== null) custom.helperTh = option.helperTh;
      groups.push(custom);
    }

    return {
      id: row.id,
      slug: row.slug,
      nameTh: row.nameTh,
      categoryId: row.categoryId,
      summaryTh: row.summaryTh,
      elevation: row.elevation,
      heroImage: row.heroImage,
      leadTimeDays: [row.leadTimeMinDays, row.leadTimeMaxDays],
      pricePerSqm: Number(row.pricePerSqmMinor / MINOR_PER_BAHT),
      minBillableSqUm: row.minBillableSqUm,
      groups,
      skuPrefix: row.skuPrefix,
    };
  }

  it('rebuilds all 81 products from the editable tables, identical to the fixture table', async () => {
    for (const fixture of coreProducts) {
      const rebuilt = await rebuild(fixture.id);
      expect(rebuilt, `${fixture.id} differs from the table`).toStrictEqual(withoutRules(fixture));
    }
  });

  it('stores every rule, its message, its severity and the groups it reads', async () => {
    let compared = 0;

    for (const fixture of coreProducts) {
      const [version] = await db
        .select({ id: productVersions.id })
        .from(productVersions)
        .where(eq(productVersions.productId, fixture.id));
      if (!version) throw new Error(`no version row for ${fixture.id}`);

      const ruleRows = await db
        .select({
          code: productVersionRules.code,
          severity: productVersionRules.severity,
          messageTh: productVersionRules.messageTh,
          whenExpr: productVersionRules.whenExpr,
          referenced: productVersionRules.referencedGroupCodes,
        })
        .from(productVersionRules)
        .where(eq(productVersionRules.productVersionId, version.id))
        .orderBy(asc(productVersionRules.sortOrder));

      expect(ruleRows.length, `${fixture.id} rule count`).toBe(fixture.rules.length);

      for (const [index, rule] of fixture.rules.entries()) {
        const stored = ruleRows[index];
        const compiled = toDocRule(rule);

        expect(stored?.code).toBe(rule.id);
        expect(stored?.severity).toBe(rule.severity);
        expect(stored?.messageTh).toBe(rule.messageTh);
        // The whole AST, node for node, including every `const` value as the decimal
        // string the document holds — a length constant that lost its digits here is a
        // rule that fires at the wrong size.
        expect(stored?.whenExpr).toStrictEqual(compiled.when);
        expect(stored?.referenced).toStrictEqual(referencedGroupCodes(rule.when));
        compared += 1;
      }
    }

    // 57 rules across the catalogue. Pinned so a query that returned nothing cannot pass
    // by comparing nothing.
    expect(compared).toBe(coreProducts.reduce((total, product) => total + product.rules.length, 0));
    expect(compared).toBeGreaterThan(0);
  });

  it('keeps the money columns exact and in satang', async () => {
    const rows = await db
      .select({ id: products.id, pricePerSqmMinor: products.pricePerSqmMinor })
      .from(products);
    const byId = new Map(rows.map((row) => [row.id, row.pricePerSqmMinor]));

    for (const fixture of coreProducts) {
      const stored = byId.get(fixture.id);
      // `bigint`, not a string that looks like one: `'135000' === 135000n` is false and
      // `'135000' + 1n` throws, but `'135000' + '1'` is a price of ฿1,350,001.
      expect(typeof stored).toBe('bigint');
      expect(stored).toBe(bahtToMinor(fixture.pricePerSqm));
    }
  });
});
