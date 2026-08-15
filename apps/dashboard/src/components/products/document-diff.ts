import { formatLeadTime } from '@wewin/core/format';
import type {
  CustomGroupWire,
  OptionGroupWire,
  ProductWire,
  RuleWire,
  SkuGroupWire,
} from '@wewin/contract';

import { baht, lengthField, sqm } from './quantities';
import { deltaText, rateMinorOf, sameDelta, sqUmOf, umOf } from './wire';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What publishing would actually change.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A published document is frozen and a draft is not, and the brief asks for that difference
 * to be impossible to miss. A badge saying "มีฉบับร่าง" is not enough — it says a draft
 * exists, not what pressing the button would do to the quotes customers are being given.
 * This module answers the second question, by comparing the two compiled documents field
 * for field.
 *
 * ### Both sides are compiled documents, and that is the whole reason to trust this
 *
 * `DraftWire.product` is not the edit form's state and is not a projection of the draft
 * rows: apps/api builds it with `encodeProduct(fromDocument(draft.document, …))` — the same
 * two steps the public read path takes — precisely so that what the dashboard previews is
 * what a publish would freeze. The other side comes from `GET /catalog/products/:slug`,
 * which is the frozen JSONB every customer is served. So this is a comparison between two
 * things that were both produced by the server, and neither of them is a reconstruction.
 *
 * ### One field is excluded on purpose: `available`
 *
 * Plan 5 point 2 keeps stock out of the frozen document, because a value going out of stock
 * must not require republishing 60 products. Both sides here have current stock overlaid on
 * top, so the field would compare equal and show nothing — but "compares equal today" is
 * not a reason, and somebody will eventually change one side's overlay. It is skipped with
 * this comment attached, so that a future reader finds the reason rather than the silence.
 *
 * ### What this cannot see
 *
 * A product whose draft has never been published has nothing to compare against, which is
 * `firstPublish` rather than an empty change list. The two are opposite: an empty list means
 * "publishing changes nothing for a customer", and for a first publish it changes everything.
 */

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface DocumentChange {
  /** Stable across renders and unique within a diff — safe as a React key. */
  readonly key: string;
  readonly section: 'fields' | 'options' | 'rules';
  readonly labelTh: string;
  readonly kind: ChangeKind;
  /** What is live now. `null` when the draft adds something that does not exist yet. */
  readonly beforeTh: string | null;
  /** What would go live. `null` when the draft removes something. */
  readonly afterTh: string | null;
}

export interface DocumentDiff {
  /** No published version exists, so every part of the draft is new to every customer. */
  readonly firstPublish: boolean;
  readonly changes: readonly DocumentChange[];
}

/**
 * A structural comparison that key order cannot spoof.
 *
 * The same trick `unpublishedFieldsOf` uses on the server for `elevation`: jsonb does not
 * preserve key order, so two objects that differ only in the order they were written must
 * not read as an edit. Applied here to the elevation and to a rule's expression, which are
 * the only two nested structures compared as wholes.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/* ------------------------------------------------------------------ *
 * Rendering a value for a person
 * ------------------------------------------------------------------ */

const OPERATION_TH: Record<string, string> = {
  fixed: 'บานติดตาย',
  casement: 'บานเปิด',
  awning: 'บานกระทุ้ง',
  slide: 'บานเลื่อน',
  fold: 'บานเฟี้ยม',
  hang: 'บานแขวน',
  vertical: 'บานเลื่อนขึ้นลง',
};

const INFILL_TH: Record<string, string> = {
  glass: 'กระจก',
  louvre: 'ระแนง',
  mesh: 'มุ้งลวด',
};

/** Operation and infill are closed unions on the wire; the lookup still falls back. */
export const elevationText = (elevation: ProductWire['elevation']): string => {
  const parts = [
    `${String(elevation.panels)} บาน`,
    OPERATION_TH[elevation.operation] ?? elevation.operation,
    INFILL_TH[elevation.infill] ?? elevation.infill,
  ];
  if (elevation.panelWidths !== undefined) {
    parts.push(`สัดส่วน ${elevation.panelWidths.join(':')}`);
  }
  if (elevation.movingPanels !== undefined) {
    parts.push(`บานที่เคลื่อนได้ ${elevation.movingPanels.map((index) => index + 1).join(', ')}`);
  }
  return parts.join(' · ');
};

/** A measurement's four bounds on one line, in the unit the group was authored in. */
export const boundsText = (group: CustomGroupWire): string =>
  `${lengthField(umOf(group.minUm), group.unit)}–${lengthField(umOf(group.maxUm), group.unit)} ${group.unit}` +
  ` · ทีละ ${lengthField(umOf(group.stepUm), group.unit)} ${group.unit}` +
  ` · เริ่มที่ ${lengthField(umOf(group.defaultUm), group.unit)} ${group.unit}`;

/** The values a group offers, in the order it offers them. */
const offeredText = (group: SkuGroupWire): string =>
  group.values.map((value) => value.labelTh).join(', ');

const valueSummary = (value: SkuGroupWire['values'][number]): string =>
  `${value.labelTh} (${value.code}) · ${deltaText(value.delta)}${value.swatchHex === undefined ? '' : ` · ${value.swatchHex}`}`;

export const groupSummary = (group: OptionGroupWire): string =>
  group.kind === 'sku'
    ? `${offeredText(group)} · ค่าเริ่มต้น ${group.defaultValue}`
    : boundsText(group);

const ruleSummary = (rule: RuleWire): string =>
  `${rule.severity === 'error' ? 'ห้าม' : 'เตือน'} · ${rule.messageTh}`;

/**
 * The Thai name of every product-level field, keyed by the identifier the API uses.
 *
 * Shared with the badge that renders `AdminProductWire.unpublishedFields`, because that
 * array holds exactly these keys (`unpublishedFieldsOf` in catalog-admin.service.ts pushes
 * them by hand) and two lists of Thai labels for one set of fields is one list that goes
 * stale. A key with no entry renders as itself rather than as an empty string — a new field
 * on the server should read oddly, not disappear.
 */
export const FIELD_LABEL_TH: Record<string, string> = {
  slug: 'สลัก (slug)',
  skuPrefix: 'คำนำหน้ารหัส SKU',
  nameTh: 'ชื่อสินค้า',
  categoryId: 'หมวดหมู่',
  summaryTh: 'คำอธิบาย',
  heroImage: 'รูปหลัก',
  leadTimeDays: 'ระยะเวลาผลิต',
  pricePerSqm: 'ราคาต่อตารางเมตร',
  minBillableSqUm: 'พื้นที่ขั้นต่ำที่คิดเงิน',
  elevation: 'รูปด้าน',
  images: 'รูปสินค้า',
  videoUrl: 'วิดีโอ',
};

export const fieldLabel = (key: string): string => FIELD_LABEL_TH[key] ?? key;

/* ------------------------------------------------------------------ *
 * The diff
 * ------------------------------------------------------------------ */

class Changes {
  private readonly list: DocumentChange[] = [];

  add(change: DocumentChange): void {
    this.list.push(change);
  }

  /** The common case: a scalar that either moved or did not. */
  compare(
    key: string,
    section: DocumentChange['section'],
    labelTh: string,
    before: string,
    after: string,
  ): void {
    if (before === after) return;
    this.add({ key, section, labelTh, kind: 'changed', beforeTh: before, afterTh: after });
  }

  get result(): readonly DocumentChange[] {
    return this.list;
  }
}

function diffFields(published: ProductWire, draft: ProductWire, changes: Changes): void {
  const field = (key: string, before: string, after: string): void => {
    changes.compare(key, 'fields', fieldLabel(key), before, after);
  };

  field('slug', published.slug, draft.slug);
  field('skuPrefix', published.skuPrefix, draft.skuPrefix);
  field('nameTh', published.nameTh, draft.nameTh);
  field('categoryId', published.categoryId, draft.categoryId);
  field('summaryTh', published.summaryTh, draft.summaryTh);
  field('heroImage', published.heroImage, draft.heroImage);
  field(
    'leadTimeDays',
    formatLeadTime([published.leadTimeDays[0], published.leadTimeDays[1]]),
    formatLeadTime([draft.leadTimeDays[0], draft.leadTimeDays[1]]),
  );
  field(
    'pricePerSqm',
    `${baht(rateMinorOf(published.pricePerSqm))}/ตร.ม.`,
    `${baht(rateMinorOf(draft.pricePerSqm))}/ตร.ม.`,
  );
  field(
    'minBillableSqUm',
    `${sqm(sqUmOf(published.minBillableSqUm))} ตร.ม.`,
    `${sqm(sqUmOf(draft.minBillableSqUm))} ตร.ม.`,
  );

  /*
   * ⭐ 0052. Reported as a count and the order, not as a list of paths: a person comparing
   * two publishes wants to know *that* the pictures moved, and `/media/<uuid>` × 6 twice
   * over tells them nothing they can read. The order is what the numbering shows.
   */
  field(
    'images',
    galleryText(published.images ?? []),
    galleryText(draft.images ?? []),
  );
  field('videoUrl', published.videoUrl ?? 'ไม่มี', draft.videoUrl ?? 'ไม่มี');

  if (canonical(published.elevation) !== canonical(draft.elevation)) {
    changes.add({
      key: 'elevation',
      section: 'fields',
      labelTh: fieldLabel('elevation'),
      kind: 'changed',
      beforeTh: elevationText(published.elevation),
      afterTh: elevationText(draft.elevation),
    });
  }
}

/**
 * A gallery as a sentence: how many pictures, and in what order.
 *
 * ⚠️ The index is part of the text on purpose. Two galleries holding the same six pictures
 * in a different order have to produce different strings, or `changes.compare` — which
 * compares the rendered text — decides the reorder never happened.
 */
function galleryText(images: readonly string[]): string {
  if (images.length === 0) return 'ไม่มีรูป';
  return `${String(images.length)} รูป — ${images
    .map((path, index) => `${String(index + 1)}. ${fileNameOf(path)}`)
    .join(' · ')}`;
}

/** The last segment of a path: `/media/<uuid>` reads as the uuid, which is at least short. */
const fileNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function diffSkuGroup(
  code: string,
  published: SkuGroupWire,
  draft: SkuGroupWire,
  changes: Changes,
): void {
  changes.compare(
    `group:${code}:offered`,
    'options',
    `${draft.labelTh} — ค่าที่เสนอ`,
    offeredText(published),
    offeredText(draft),
  );
  changes.compare(
    `group:${code}:default`,
    'options',
    `${draft.labelTh} — ค่าเริ่มต้น`,
    published.defaultValue,
    draft.defaultValue,
  );

  /*
   * A value's label, colour and surcharge belong to the catalogue-wide `option_values` row,
   * not to this product's draft — so they can move without anybody touching this product,
   * and publishing freezes whatever they say at that moment. That makes them exactly the
   * changes somebody publishing needs to see, and the ones they are least likely to expect.
   */
  const before = new Map(published.values.map((value) => [value.code, value]));
  for (const value of draft.values) {
    const previous = before.get(value.code);
    if (previous === undefined) continue; // an added value is already reported as an offer change

    if (
      previous.labelTh !== value.labelTh ||
      previous.swatchHex !== value.swatchHex ||
      !sameDelta(previous.delta, value.delta)
    ) {
      changes.add({
        key: `group:${code}:value:${value.code}`,
        section: 'options',
        labelTh: `${draft.labelTh} — ตัวเลือก ${value.code}`,
        kind: 'changed',
        beforeTh: valueSummary(previous),
        afterTh: valueSummary(value),
      });
    }
  }
}

function diffCustomGroup(
  code: string,
  published: CustomGroupWire,
  draft: CustomGroupWire,
  changes: Changes,
): void {
  changes.compare(
    `group:${code}:bounds`,
    'options',
    `${draft.labelTh} — ช่วงขนาด`,
    boundsText(published),
    boundsText(draft),
  );
  changes.compare(
    `group:${code}:helper`,
    'options',
    `${draft.labelTh} — คำอธิบายช่วย`,
    published.helperTh ?? '—',
    draft.helperTh ?? '—',
  );
}

function diffGroups(published: ProductWire, draft: ProductWire, changes: Changes): void {
  const before = new Map(published.groups.map((group) => [group.code, group]));
  const after = new Map(draft.groups.map((group) => [group.code, group]));

  for (const group of draft.groups) {
    const previous = before.get(group.code);
    if (previous === undefined) {
      changes.add({
        key: `group:${group.code}`,
        section: 'options',
        labelTh: `เพิ่มชุดตัวเลือก ${group.labelTh}`,
        kind: 'added',
        beforeTh: null,
        afterTh: groupSummary(group),
      });
      continue;
    }

    changes.compare(
      `group:${group.code}:label`,
      'options',
      `ชื่อชุดตัวเลือก ${group.code}`,
      previous.labelTh,
      group.labelTh,
    );

    /*
     * A group that changed kind is a group that was deleted and recreated under one code —
     * `option_groups.kind` is not editable, so this is unreachable through the dashboard and
     * is reported rather than crashed on, because the seed and psql can both produce it.
     */
    if (previous.kind !== group.kind) {
      changes.add({
        key: `group:${group.code}:kind`,
        section: 'options',
        labelTh: `ชนิดของชุดตัวเลือก ${group.labelTh}`,
        kind: 'changed',
        beforeTh: groupSummary(previous),
        afterTh: groupSummary(group),
      });
      continue;
    }

    if (previous.kind === 'sku' && group.kind === 'sku') {
      diffSkuGroup(group.code, previous, group, changes);
    } else if (previous.kind === 'custom' && group.kind === 'custom') {
      diffCustomGroup(group.code, previous, group, changes);
    }
  }

  for (const group of published.groups) {
    if (after.has(group.code)) continue;
    changes.add({
      key: `group:${group.code}`,
      section: 'options',
      labelTh: `ลบชุดตัวเลือก ${group.labelTh}`,
      kind: 'removed',
      beforeTh: groupSummary(group),
      afterTh: null,
    });
  }

  /*
   * Order is what a customer scrolls through, so a reorder is a real change — but only worth
   * reporting when nothing else already explains it. Added and removed groups move
   * everything after them, and a second line saying so would be noise on top of the line
   * that mattered.
   */
  const publishedCodes = published.groups.map((group) => group.code);
  const draftCodes = draft.groups.map((group) => group.code);
  const sameSet =
    publishedCodes.length === draftCodes.length && publishedCodes.every((code) => after.has(code));
  if (sameSet && publishedCodes.join('|') !== draftCodes.join('|')) {
    changes.add({
      key: 'group-order',
      section: 'options',
      labelTh: 'ลำดับชุดตัวเลือก',
      kind: 'changed',
      beforeTh: publishedCodes.join(' → '),
      afterTh: draftCodes.join(' → '),
    });
  }
}

function diffRules(published: ProductWire, draft: ProductWire, changes: Changes): void {
  const before = new Map(published.rules.map((rule) => [rule.id, rule]));
  const after = new Map(draft.rules.map((rule) => [rule.id, rule]));

  for (const rule of draft.rules) {
    const previous = before.get(rule.id);
    if (previous === undefined) {
      changes.add({
        key: `rule:${rule.id}`,
        section: 'rules',
        labelTh: `เพิ่มกฎ ${rule.id}`,
        kind: 'added',
        beforeTh: null,
        afterTh: ruleSummary(rule),
      });
      continue;
    }

    if (
      previous.messageTh !== rule.messageTh ||
      previous.severity !== rule.severity ||
      canonical(previous.when) !== canonical(rule.when)
    ) {
      changes.add({
        key: `rule:${rule.id}`,
        section: 'rules',
        labelTh: `กฎ ${rule.id}`,
        kind: 'changed',
        beforeTh: ruleSummary(previous),
        afterTh: ruleSummary(rule),
      });
    }
  }

  for (const rule of published.rules) {
    if (after.has(rule.id)) continue;
    changes.add({
      key: `rule:${rule.id}`,
      section: 'rules',
      labelTh: `ลบกฎ ${rule.id}`,
      kind: 'removed',
      beforeTh: ruleSummary(rule),
      afterTh: null,
    });
  }
}

export function diffDocuments(
  published: ProductWire | null,
  draft: ProductWire,
): DocumentDiff {
  if (published === null) return { firstPublish: true, changes: [] };

  const changes = new Changes();
  diffFields(published, draft, changes);
  diffGroups(published, draft, changes);
  diffRules(published, draft, changes);

  return { firstPublish: false, changes: changes.result };
}
