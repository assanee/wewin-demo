import 'client-only';

import {
  adminProductListWireSchema,
  adminProductWireSchema,
  draftWireSchema,
  publishResultWireSchema,
  type AdminOptionGroupListWire,
  type AdminOptionGroupWire,
  type AdminOptionValueWire,
  type AdminProductListWire,
  type AdminProductWire,
  type CreateProductRequestWire,
  type DraftOptionWire,
  type DraftRuleWire,
  type DraftWire,
  type ProductFieldsPatchWire,
  type PublishResultWire,
} from '@wewin/contract/admin';
import { categoryWireSchema, priceDeltaWireSchema, productDocumentWireSchema } from '@wewin/contract/catalog';
import type { CategoryWire, PriceDeltaWire, ProductDocumentWire } from '@wewin/contract';

import { apiFetch, apiJson } from '@/lib/api/client';
import { ApiError, apiErrorFromResponse } from '@/lib/api/errors';

/**
 * Every call the product screens make, in one file, decoded rather than cast.
 *
 * `apiJson` takes a decoder as a required argument on purpose — its own header explains
 * why `apiJson<AdminProductWire>(…)` returning `body as AdminProductWire` is how a field
 * renamed six weeks ago becomes `undefined` three components deep. So each function below
 * names the schema that checks its answer, and the schemas come from `@wewin/contract`,
 * which is the same module apps/api validated the request against. One definition, both
 * ends.
 *
 * ### The hash is not optional and is not this module's to remember
 *
 * Every draft mutation carries `expectedDocumentHash`, and every one of them answers with a
 * fresh `DraftWire` carrying the next one. That is plan 5 point 5 turned inward: two people
 * editing one draft is otherwise last-write-wins over a whole option list, silently. This
 * module therefore takes the hash as an explicit argument on every mutation and never keeps
 * a copy of it — a cached hash is a stale hash, and a client that quietly reuses one has
 * disabled the check while appearing to perform it. `useDraft` holds the current hash and
 * passes it in, because the component that owns the draft is the one that knows which
 * version of it the person is looking at.
 *
 * ### Where the published document comes from
 *
 * `GET /admin/catalog/products/:id` reports the published version's *identity* — id, number,
 * hash, timestamp — and not its content, deliberately: a list of 81 products would otherwise
 * carry 81 compiled documents. So the publish diff reads the live document from the public
 * read endpoint, `GET /catalog/products/:slug`, which is the same frozen JSONB every
 * customer is served. Comparing against anything else would be comparing against a
 * reconstruction.
 */

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export const listProducts = (): Promise<AdminProductListWire> =>
  apiJson('/admin/catalog/products', (body) => adminProductListWireSchema.parse(body));

export const getProduct = (productId: string): Promise<AdminProductWire> =>
  apiJson(`/admin/catalog/products/${encodeURIComponent(productId)}`, (body) =>
    adminProductWireSchema.parse(body),
  );

/**
 * The categories a product may belong to.
 *
 * From the public catalogue rather than an admin endpoint, because there is no admin one:
 * categories are not editable in this phase, and `GET /catalog/categories` is declared
 * public in apps/api's route table. `anonymous` is *not* set — the call works either way,
 * and sending the bearer token keeps a signed-in session's requests uniform.
 */
export const listCategories = (): Promise<readonly CategoryWire[]> =>
  apiJson('/catalog/categories', (body) => {
    if (typeof body !== 'object' || body === null || !('categories' in body)) {
      throw new TypeError('expected { categories: [...] }');
    }
    const { categories } = body as { categories: unknown };
    if (!Array.isArray(categories)) throw new TypeError('categories is not an array');
    return categories.map((entry: unknown) => categoryWireSchema.parse(entry));
  });

/**
 * The document customers are being served right now, or `null` when there is not one.
 *
 * A 404 here is an ordinary answer rather than an error: a product whose first draft has
 * never been published has no live document, and the publish dialog needs to say "this will
 * be the first version" rather than fail. Every other failure still throws.
 */
export async function getPublishedDocument(slug: string): Promise<ProductDocumentWire | null> {
  try {
    return await apiJson(`/catalog/products/${encodeURIComponent(slug)}`, (body) =>
      productDocumentWireSchema.parse(body),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The live document for a product, found by id rather than by the slug it currently has.
 *
 * `GET /catalog/products/:slug` is addressed by slug, and the draft is allowed to *change*
 * the slug — that is one of the fields `unpublishedFields` reports. So the obvious call,
 * `getPublishedDocument(product.slug)`, answers 404 for exactly the product whose draft
 * renamed it, and a publish dialog reading that 404 as "there is no published version" would
 * offer to publish a first version over the top of a live one, showing no diff at all. The
 * frozen document keeps the slug it was frozen with; only the editable row moved.
 *
 * So: try the cheap call, insist the answer is about the product asked for, and fall back to
 * the public list — which carries every published document and can be indexed by id — only
 * when it is not. The fallback is a large response and is paid for only in the case that
 * needs it, which is the one where being wrong is expensive.
 */
export async function getPublishedDocumentOf(
  productId: string,
  slug: string,
): Promise<ProductDocumentWire | null> {
  const bySlug = await getPublishedDocument(slug);
  if (bySlug !== null && bySlug.product.id === productId) return bySlug;

  const published = await apiJson('/catalog/products', (body) => {
    if (typeof body !== 'object' || body === null || !('products' in body)) {
      throw new TypeError('expected { products: [...] }');
    }
    const { products } = body as { products: unknown };
    if (!Array.isArray(products)) throw new TypeError('products is not an array');
    return products.map((entry: unknown) => productDocumentWireSchema.parse(entry));
  });

  return published.find((document) => document.product.id === productId) ?? null;
}

/* ------------------------------------------------------------------ *
 * The option catalogue
 * ------------------------------------------------------------------ */

/**
 * Narrowed by hand, because `@wewin/contract` publishes no schema for this response.
 *
 * `admin.ts` ships response schemas for the product shapes (`adminProductListWireSchema`
 * and friends) and stops short of the option-catalogue ones. Rather than reach into
 * packages/contract from an app — which is what `turbo boundaries` exists to prevent
 * becoming normal — the check lives here, written the way apps/api writes its own
 * (`isRouteAccess`, `isPermissionCode`): narrow, never cast, and throw with the field name
 * so `apiJson` can turn it into a MALFORMED with the path attached.
 *
 * The delta is the one part that is not hand-rolled. `priceDeltaWireSchema` is exported and
 * is the part that actually matters — a surcharge whose unit is misread is money.
 */
function decodeOptionValue(input: unknown): AdminOptionValueWire {
  if (typeof input !== 'object' || input === null) throw new TypeError('option value is not an object');
  const row = input as Record<string, unknown>;

  const code = row['code'];
  const labelTh = row['labelTh'];
  const available = row['available'];
  const sortOrder = row['sortOrder'];
  const swatchHex = row['swatchHex'];

  if (typeof code !== 'string' || code === '') throw new TypeError('option value has no code');
  if (typeof labelTh !== 'string') throw new TypeError(`option value "${code}" has no labelTh`);
  if (typeof available !== 'boolean') throw new TypeError(`option value "${code}" has no available`);
  if (typeof sortOrder !== 'number') throw new TypeError(`option value "${code}" has no sortOrder`);
  if (swatchHex !== undefined && typeof swatchHex !== 'string') {
    throw new TypeError(`option value "${code}" has a non-string swatchHex`);
  }

  const delta: PriceDeltaWire = priceDeltaWireSchema.parse(row['delta']);

  /*
   * Spread rather than an always-present `swatchHex: undefined`: `exactOptionalPropertyTypes`
   * makes the two different types, and the second one would serialise a null colour into
   * every request that echoes a value back.
   */
  return {
    code,
    labelTh,
    delta,
    available,
    sortOrder,
    ...(swatchHex === undefined ? {} : { swatchHex }),
  };
}

const KINDS = ['sku', 'custom'] as const;
const INPUTS = ['swatch', 'chip', 'toggle', 'number'] as const;
const AUTHORED_UNITS = ['cm', 'mm'] as const;

const isOneOf = <T extends string>(values: readonly T[], candidate: unknown): candidate is T =>
  typeof candidate === 'string' && (values as readonly string[]).includes(candidate);

function decodeOptionGroup(input: unknown): AdminOptionGroupWire {
  if (typeof input !== 'object' || input === null) throw new TypeError('option group is not an object');
  const row = input as Record<string, unknown>;

  const code = row['code'];
  const kind = row['kind'];
  const labelTh = row['labelTh'];
  const inputStyle = row['input'];
  const includeInSkuCode = row['includeInSkuCode'];
  const authoredUnit = row['authoredUnit'];
  const helperTh = row['helperTh'];
  const values = row['values'];

  if (typeof code !== 'string' || code === '') throw new TypeError('option group has no code');
  if (!isOneOf(KINDS, kind)) throw new TypeError(`option group "${code}" has an unknown kind`);
  if (typeof labelTh !== 'string') throw new TypeError(`option group "${code}" has no labelTh`);
  if (!isOneOf(INPUTS, inputStyle)) throw new TypeError(`option group "${code}" has an unknown input`);
  if (typeof includeInSkuCode !== 'boolean') {
    throw new TypeError(`option group "${code}" has no includeInSkuCode`);
  }
  if (authoredUnit !== undefined && !isOneOf(AUTHORED_UNITS, authoredUnit)) {
    throw new TypeError(`option group "${code}" has an unknown authoredUnit`);
  }
  if (helperTh !== undefined && typeof helperTh !== 'string') {
    throw new TypeError(`option group "${code}" has a non-string helperTh`);
  }
  if (!Array.isArray(values)) throw new TypeError(`option group "${code}" has no values array`);

  return {
    code,
    kind,
    labelTh,
    input: inputStyle,
    includeInSkuCode,
    values: values.map(decodeOptionValue),
    ...(authoredUnit === undefined ? {} : { authoredUnit }),
    ...(helperTh === undefined ? {} : { helperTh }),
  };
}

export const listOptionGroups = (): Promise<AdminOptionGroupListWire> =>
  apiJson('/admin/catalog/option-groups', (body) => {
    if (typeof body !== 'object' || body === null || !('groups' in body)) {
      throw new TypeError('expected { groups: [...] }');
    }
    const { groups } = body as { groups: unknown };
    if (!Array.isArray(groups)) throw new TypeError('groups is not an array');
    return { groups: groups.map(decodeOptionGroup) };
  });

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const withMethod = (method: string, body: unknown): RequestInit => ({ ...json(body), method });

const draft = (body: unknown): DraftWire => draftWireSchema.parse(body);

export const createProduct = (request: CreateProductRequestWire): Promise<DraftWire> =>
  apiJson('/admin/catalog/products', draft, json(request));

/**
 * Start the next version.
 *
 * There is no request body and no hash to send: opening a draft is the one write that has
 * no draft to be stale against. It copies the published version's rows, so a colleague who
 * opened one thirty seconds ago makes this a 409 rather than a second draft — which is
 * `openDraft` in the service refusing, not something a client can prevent.
 */
export const openDraft = (productId: string): Promise<DraftWire> =>
  apiJson(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft`,
    draft,
    { method: 'POST' },
  );

export const getDraft = (productId: string): Promise<DraftWire> =>
  apiJson(`/admin/catalog/products/${encodeURIComponent(productId)}/draft`, draft);

export const updateDraft = (
  productId: string,
  expectedDocumentHash: string,
  patch: {
    readonly slug?: string | undefined;
    readonly skuPrefix?: string | undefined;
    readonly fields?: ProductFieldsPatchWire | undefined;
  },
): Promise<DraftWire> =>
  apiJson(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft`,
    draft,
    withMethod('PATCH', { expectedDocumentHash, ...patch }),
  );

export const putOption = (
  productId: string,
  groupCode: string,
  expectedDocumentHash: string,
  option: DraftOptionWire,
): Promise<DraftWire> =>
  apiJson(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft/options/${encodeURIComponent(groupCode)}`,
    draft,
    withMethod('PUT', { expectedDocumentHash, option }),
  );

/**
 * The hash travels in the query string on every DELETE.
 *
 * apps/api's controller says why: a body on DELETE has no defined semantics and is dropped
 * by some proxies. The value and the check are identical to the ones a PUT carries.
 */
const hashQuery = (expectedDocumentHash: string): string =>
  `?${new URLSearchParams({ expectedDocumentHash }).toString()}`;

export const deleteOption = (
  productId: string,
  groupCode: string,
  expectedDocumentHash: string,
): Promise<DraftWire> =>
  apiJson(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft/options/${encodeURIComponent(groupCode)}${hashQuery(expectedDocumentHash)}`,
    draft,
    { method: 'DELETE' },
  );

export const putRule = (
  productId: string,
  ruleCode: string,
  expectedDocumentHash: string,
  rule: DraftRuleWire,
): Promise<DraftWire> =>
  apiJson(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft/rules/${encodeURIComponent(ruleCode)}`,
    draft,
    withMethod('PUT', { expectedDocumentHash, rule }),
  );

export const deleteRule = (
  productId: string,
  ruleCode: string,
  expectedDocumentHash: string,
): Promise<DraftWire> =>
  apiJson(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft/rules/${encodeURIComponent(ruleCode)}${hashQuery(expectedDocumentHash)}`,
    draft,
    { method: 'DELETE' },
  );

/** 204, so there is no body to decode — only a status to insist on. */
export async function discardDraft(productId: string, expectedDocumentHash: string): Promise<void> {
  const response = await apiFetch(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft${hashQuery(expectedDocumentHash)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
}

/**
 * Freeze the draft.
 *
 * Both handles go up: the version id says *which* draft is meant, so that a colleague's
 * open-and-edit is a 404 rather than a publication of their work, and the hash catches the
 * case where the id still matches because they edited the same draft instead of opening a
 * new one.
 */
export const publishDraft = (
  productId: string,
  productVersionId: string,
  expectedDocumentHash: string,
): Promise<PublishResultWire> =>
  apiJson(
    `/admin/catalog/products/${encodeURIComponent(productId)}/draft/publish`,
    (body) => publishResultWireSchema.parse(body),
    json({ productVersionId, expectedDocumentHash }),
  );

/* ------------------------------------------------------------------ *
 * Reading a failure
 * ------------------------------------------------------------------ */

/**
 * Whether this failure means "somebody moved the draft under you".
 *
 * Every mutation can answer 409 for that reason, and the only useful response is to reload
 * rather than to retry — a retry with the same stale hash produces the same 409 forever,
 * and a retry with a refreshed one would silently overwrite whatever the colleague did.
 */
export const isStaleDraft = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'CONFLICT';

export const isForbidden = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'FORBIDDEN';

/** The prose to show for any failure, without ever showing an empty string. */
/**
 * ⚠️ One of three copies that predate `@/lib/api/errors`, now delegating to it rather than
 * restating it. It stopped being a harmless duplicate the day the canonical one learned to
 * render `RbacGuard`'s English `Missing permission: …` in Thai: a copy that did not would put
 * that sentence on this screen and nowhere else, which is worse than either answer alone.
 */
export { failureMessage } from '@/lib/api/errors';
