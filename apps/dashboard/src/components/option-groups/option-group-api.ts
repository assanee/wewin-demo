import 'client-only';

import type {
  CreateOptionGroupRequestWire,
  CreateOptionValueRequestWire,
  UpdateOptionGroupRequestWire,
  UpdateOptionValueRequestWire,
} from '@wewin/contract/admin';

import { apiFetch } from '@/lib/api/client';
import { apiErrorFromResponse } from '@/lib/api/errors';

/**
 * The writes the option-group screen makes.
 *
 * Reads live in `products/catalog-api.ts` because `listOptionGroups` was already there —
 * the product editor needs the same list to offer options — and one endpoint answered by
 * two decoders is how the two drift.
 *
 * ── ⚠️ Every one of these answers 204 with no body ───────────────────────────────
 *
 * All five endpoints in `OptionCatalogController` are `@HttpCode(204)` and return
 * `Promise<void>`. The first version of this file assumed they answered with the updated
 * group, and the failure that produced is worth writing down because it is the worst shape
 * a bug can take on a screen like this:
 *
 *   The write **succeeded** — the row changed in Postgres — and the decoder then rejected
 *   the empty body, so the screen showed "ทำรายการไม่สำเร็จ" and went on displaying the old
 *   state. A person reading that presses the button again. On this particular screen the
 *   button is "withdraw this colour from sale", which is at least idempotent; on the next
 *   one it might not be.
 *
 * Found by clicking it in a browser and then reading the table in psql. No test would have
 * caught it: a fake returning the shape this file expected was exactly the wrong oracle.
 *
 * So these return `void`, and the caller re-lists. That is one extra request per edit
 * against a payload of ten groups, which is the right price for a screen that shows what
 * the server actually holds rather than what the client believed it sent.
 */

const send = async (path: string, method: string, body: unknown): Promise<void> => {
  const response = await apiFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
};

const groupPath = (groupCode: string): string =>
  `/admin/catalog/option-groups/${encodeURIComponent(groupCode)}`;

const valuePath = (groupCode: string, valueCode: string): string =>
  `${groupPath(groupCode)}/values/${encodeURIComponent(valueCode)}`;

export const createOptionGroup = (request: CreateOptionGroupRequestWire): Promise<void> =>
  send('/admin/catalog/option-groups', 'POST', request);

/**
 * Rename a group, or change its helper text.
 *
 * ⚠️ **`code`, `kind`, `input` and `includeInSkuCode` are not here, and cannot be.**
 * `UpdateOptionGroupRequestWire` carries two fields and the API refuses anything else.
 * `code` and `includeInSkuCode` are ingredients of a SKU string that has been printed on
 * quotations and stamped onto order lines; changing either would make yesterday's SKU
 * describe a different product. The field simply is not offered.
 */
export const updateOptionGroup = (
  groupCode: string,
  request: UpdateOptionGroupRequestWire,
): Promise<void> => send(groupPath(groupCode), 'PATCH', request);

export const createOptionValue = (
  groupCode: string,
  request: CreateOptionValueRequestWire,
): Promise<void> => send(`${groupPath(groupCode)}/values`, 'POST', request);

export const updateOptionValue = (
  groupCode: string,
  valueCode: string,
  request: UpdateOptionValueRequestWire,
): Promise<void> => send(valuePath(groupCode, valueCode), 'PATCH', request);

/**
 * ⚠️ **The one write on this screen that a customer sees immediately.**
 *
 * `available` is a separate endpoint in the contract, and its comment gives the reason: it
 * is the single catalogue fact that changes without a publish, so it is deliberately not
 * foldable into a label edit. Everything else here changes vocabulary and reaches a customer
 * only when somebody publishes a version; this takes a colour out of stock on every
 * published version that offers it, the moment it is called.
 *
 * PUT and not PATCH: the request is the whole state of one boolean, so sending it twice has
 * to mean what sending it once meant.
 */
export const setOptionValueAvailability = (
  groupCode: string,
  valueCode: string,
  available: boolean,
): Promise<void> => send(`${valuePath(groupCode, valueCode)}/availability`, 'PUT', { available });
