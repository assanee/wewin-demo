import { reviewsApiBaseUrl } from '../reviews/api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ REMEMBERING WHAT THE CUSTOMER ALREADY TOLD US.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `RequestQuotationForm` asks for a name, a number and an address every single time, even
 * from somebody who typed all three last month. This module answers "what would this person
 * already have written?" so that form can fill itself in — without ever pretending to know
 * something it does not.
 *
 * ── Two sources, and a strict order between them ─────────────────────────────
 *
 * **The most recent order wins.** `GET /orders` is ownership-scoped and already used by
 * `MyQuotations` for the same list; its rows carry no contact, so the newest *submitted* one
 * is opened with `GET /orders/:id` to read it. That is what the customer most recently told
 * us, in their own words, for a real quotation.
 *
 * **The account is the fallback**, read only when there is no prior order at all. It has no
 * name — `displayName` is never set by phone registration, and this module does not invent
 * one — but it does have the one thing every customer here has: the number they registered
 * with, from the new `phones` field on `AccountWire`.
 *
 * ⚠️ This is a strict either/or, not a field-by-field merge. If a prior order exists, its
 * contact is used exactly as it was recorded — even a channel that order left blank stays
 * blank rather than being topped up from the account. Ambiguity there is not worth the
 * complexity: the fallback is for "never told us anything", not "told us something partial".
 *
 * ── Degrading silently, at every step ─────────────────────────────────────────
 *
 * Every fetch here can fail — no API configured, the network is down, a 500, a body that
 * does not parse. None of that may reach the form as an error: `fetchContactPrefill` never
 * throws and never rejects, and a caller that gets `null` back should render exactly as if
 * this module did not exist.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The three fields the form has, always present so a caller never has to ask "which one". */
export interface ContactPrefill {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
}

const EMPTY_PREFILL: ContactPrefill = { name: '', phone: '', email: '' };

interface OrderContactRaw {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

interface AccountContactRaw {
  readonly phone: string | null;
  readonly email: string | null;
}

/* ------------------------------------------------------------------ *
 * Precedence — the part worth pinning with a test that never touches a network
 * ------------------------------------------------------------------ */

/**
 * ⭐ The last order wins over the account; the account is only reached at all when there is
 * no order to ask. See the module note for why this is either/or rather than a merge.
 */
export function resolveContactPrefill(
  order: OrderContactRaw | null,
  account: AccountContactRaw | null,
): ContactPrefill {
  if (order !== null) {
    return { name: order.name ?? '', phone: order.phone ?? '', email: order.email ?? '' };
  }

  if (account !== null) {
    /* No name: see the module note — `displayName` is not this feature's to show. */
    return { name: '', phone: account.phone ?? '', email: account.email ?? '' };
  }

  return EMPTY_PREFILL;
}

/* ------------------------------------------------------------------ *
 * Not clobbering typing — the other part worth pinning without a network
 * ------------------------------------------------------------------ */

export interface ContactTouched {
  readonly name: boolean;
  readonly phone: boolean;
  readonly email: boolean;
}

/**
 * ⭐ Which fields a pre-fill may write, given what the customer has already touched.
 *
 * A key is present only for a field that is both untouched and has something to offer — an
 * empty string from `prefill` is "this source had nothing", not "clear what is there". The
 * form applies exactly the keys present here and reads nothing else, so a stale value
 * sitting in `prefill` for an already-typed field can never reach `setState`.
 */
export function fieldsToApply(
  touched: ContactTouched,
  prefill: ContactPrefill,
): Partial<ContactPrefill> {
  const result: { -readonly [K in keyof ContactPrefill]?: ContactPrefill[K] } = {};

  if (!touched.name && prefill.name !== '') result.name = prefill.name;
  if (!touched.phone && prefill.phone !== '') result.phone = prefill.phone;
  if (!touched.email && prefill.email !== '') result.email = prefill.email;

  return result;
}

/* ------------------------------------------------------------------ *
 * The network — every failure here becomes `null`, never a throw
 * ------------------------------------------------------------------ */

/** `{ orders: [{ id, submittedAt }] }` — only what is needed to find the newest submitted one. */
function decodeOrderList(body: unknown): readonly { readonly id: string; readonly submittedAt: string | null }[] | null {
  if (!isRecord(body) || !Array.isArray(body['orders'])) return null;

  return body['orders'].flatMap((raw) => {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') return [];
    return [{ id: raw['id'], submittedAt: asString(raw['submittedAt']) }];
  });
}

/** `{ contact: { name, phone, email } }` off `GET /orders/:id` — `OrderContactWire`, restated. */
function decodeOrderContact(body: unknown): OrderContactRaw | null {
  if (!isRecord(body) || !isRecord(body['contact'])) return null;
  const contact = body['contact'];
  return { name: asString(contact['name']), phone: asString(contact['phone']), email: asString(contact['email']) };
}

/**
 * `{ phones: [{number, isPrimary}], emails: [{address, isPrimary}] }` off `GET /me/account` —
 * the primary one when there is one, otherwise whichever came first, per field independently.
 */
function decodeAccountContact(body: unknown): AccountContactRaw | null {
  if (!isRecord(body) || !Array.isArray(body['phones']) || !Array.isArray(body['emails'])) return null;

  const pick = (rows: readonly unknown[], key: string): string | null => {
    const usable = rows.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw[key] !== 'string') return [];
      return [{ value: raw[key], isPrimary: raw['isPrimary'] === true }];
    });
    return (usable.find((row) => row.isPrimary) ?? usable[0])?.value ?? null;
  };

  return { phone: pick(body['phones'], 'number'), email: pick(body['emails'], 'address') };
}

async function getJson(url: string, accessToken: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      /* Contact details are personal to this customer; the same reason `MyQuotations` gives. */
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The newest *submitted* order's contact, or `null` for "no such order" and for any failure
 * along the way — the two calls the module note describes.
 *
 * ⚠️ `limit=50`, mirroring `MyQuotations`, and not `limit=1`. `GET /orders` sorts by
 * `updatedAt`, so the single newest row can be an untouched draft cart with no contact at
 * all; scanning further down for the newest row that was actually submitted is what makes
 * this the customer's last *quotation* rather than their last click.
 */
async function fetchLastOrderContact(base: string, accessToken: string): Promise<OrderContactRaw | null> {
  const list = decodeOrderList(await getJson(`${base}/orders?limit=50`, accessToken));
  const newest = list?.find((row) => row.submittedAt !== null);
  if (newest === undefined) return null;

  return decodeOrderContact(await getJson(`${base}/orders/${newest.id}`, accessToken));
}

async function fetchAccountContact(base: string, accessToken: string): Promise<AccountContactRaw | null> {
  return decodeAccountContact(await getJson(`${base}/me/account`, accessToken));
}

/**
 * What to pre-fill the quotation form's contact fields with.
 *
 * `null` only when neither source could even be asked — no configured API, or the account
 * fetch itself failed. Otherwise this always resolves to a `ContactPrefill`, with an empty
 * string in any field neither source had anything for; a caller applies it the same way
 * either way, since an empty string is never written over what is already on screen.
 */
export async function fetchContactPrefill(accessToken: string): Promise<ContactPrefill | null> {
  const base = reviewsApiBaseUrl();
  if (base === null) return null;

  const order = await fetchLastOrderContact(base, accessToken);
  if (order !== null) return resolveContactPrefill(order, null);

  const account = await fetchAccountContact(base, accessToken);
  if (account !== null) return resolveContactPrefill(null, account);

  return null;
}
