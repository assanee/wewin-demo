import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@wewin/db';
import {
  encodeStoredPriceDelta,
  type AdminOptionGroupListWire,
  type AdminOptionGroupWire,
  type AdminOptionValueWire,
  type CreateOptionGroupRequestWire,
  type CreateOptionValueRequestWire,
  type SetOptionValueAvailabilityRequestWire,
  type UpdateOptionGroupRequestWire,
  type UpdateOptionValueRequestWire,
} from '@wewin/contract/admin';

import { AppError } from '../common/errors/app-error';
import { DRIZZLE } from '../database/database.tokens';
import { DraftRepository } from './draft.repository';

/**
 * The option catalogue: groups and values, shared across every product.
 *
 * The 81 seeded products are built from ten group factories, so `profile_color` is one
 * concept catalogue-wide and only its *use* is per product. That split is why this service
 * is separate from `CatalogAdminService` and why none of it touches a draft: renaming a
 * colour or taking it out of stock must not require opening 60 drafts.
 *
 * Which raises the question these three writes have to answer differently, and do:
 *
 *   **label, swatch, sort order** — cosmetic, and copied into every document that was
 *   compiled while they held their old value. Editing them changes nothing already
 *   published, which is correct: a published document is what a customer was quoted from,
 *   including the words on it.
 *
 *   **delta** — the surcharge. Same rule, and it is the one that matters: changing a
 *   surcharge here does *not* reprice anything already published, because the amount was
 *   frozen into each document at publish time. It applies to the next compile of each
 *   draft that offers the value. Anything else would be a price change with no publish
 *   behind it and no version to point an order at.
 *
 *   **available** — the exception plan 5 point 2 carves out, and the only write on this
 *   whole surface that changes what a customer sees immediately. It is not in the frozen
 *   document precisely so that stock can move without republishing 60 products, and it has
 *   its own endpoint so that taking a colour out of stock is never something that happened
 *   on the way to renaming it.
 */
@Injectable()
export class OptionCatalogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly drafts: DraftRepository,
  ) {}

  async list(): Promise<AdminOptionGroupListWire> {
    return this.db.transaction(async (tx) => {
      const { groups, values } = await this.drafts.listOptionGroups(tx);

      const byGroup = new Map<string, AdminOptionValueWire[]>();
      for (const value of values) {
        const wire: AdminOptionValueWire = {
          code: value.code,
          labelTh: value.labelTh,
          ...(value.swatchHex === null ? {} : { swatchHex: value.swatchHex }),
          delta: encodeStoredPriceDelta({
            type: value.deltaType,
            minor: value.deltaMinor,
            bp: value.deltaBp,
          }),
          available: value.available,
          sortOrder: value.sortOrder,
        };
        const bucket = byGroup.get(value.groupCode);
        if (bucket) bucket.push(wire);
        else byGroup.set(value.groupCode, [wire]);
      }

      const wired: AdminOptionGroupWire[] = groups.map((group) => ({
        code: group.code,
        kind: group.kind,
        labelTh: group.labelTh,
        input: group.input,
        includeInSkuCode: group.includeInSkuCode,
        ...(group.authoredUnit === null ? {} : { authoredUnit: group.authoredUnit }),
        ...(group.helperTh === null ? {} : { helperTh: group.helperTh }),
        values: byGroup.get(group.code) ?? [],
      }));

      return { groups: wired };
    });
  }

  async createGroup(request: CreateOptionGroupRequestWire): Promise<void> {
    await this.db.transaction((tx) => this.drafts.insertOptionGroup(tx, request));
  }

  async updateGroup(groupCode: string, request: UpdateOptionGroupRequestWire): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.drafts.requireGroup(tx, groupCode);
      await this.drafts.updateOptionGroup(tx, groupCode, request);
    });
  }

  /**
   * Add a value to a group.
   *
   * A measurement group has nothing to enumerate — `option_values_sku_groups_only` refuses
   * the row — so the refusal is stated here, where the group code can be named, rather than
   * arriving as a CHECK violation naming a constraint.
   */
  async createValue(groupCode: string, request: CreateOptionValueRequestWire): Promise<void> {
    await this.db.transaction(async (tx) => {
      const group = await this.drafts.requireGroup(tx, groupCode);
      if (group.kind !== 'sku') {
        throw AppError.validationFailed(
          `กลุ่ม "${groupCode}" เป็นกลุ่มวัดขนาด จึงไม่มีรายการตัวเลือกให้เพิ่ม`,
          { groupCode },
        );
      }
      await this.drafts.insertOptionValue(tx, group, request);
    });
  }

  async updateValue(
    groupCode: string,
    valueCode: string,
    request: UpdateOptionValueRequestWire,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const group = await this.drafts.requireGroup(tx, groupCode);
      const updated = await this.drafts.updateOptionValue(tx, group.id, valueCode, request);
      if (!updated) {
        throw AppError.notFound(`ไม่พบตัวเลือกรหัส "${valueCode}" ในกลุ่ม "${groupCode}"`, {
          groupCode,
          valueCode,
        });
      }
    });
  }

  async setAvailability(
    groupCode: string,
    valueCode: string,
    request: SetOptionValueAvailabilityRequestWire,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const group = await this.drafts.requireGroup(tx, groupCode);
      const updated = await this.drafts.setOptionValueAvailability(
        tx,
        group.id,
        valueCode,
        request.available,
      );
      if (!updated) {
        throw AppError.notFound(`ไม่พบตัวเลือกรหัส "${valueCode}" ในกลุ่ม "${groupCode}"`, {
          groupCode,
          valueCode,
        });
      }
    });
  }
}
