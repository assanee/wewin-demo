import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ A MATERIAL BELONGS TO A PRODUCT, NEVER TO A STATUS OR A SHARED LABEL.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's rule, in their own words: *"ที่ฉันพูดก่อนหน้าคือมีคำว่า อะลูมิเนียม อยู่ในสถานะ
 * หรือ หัวตาราง ซึ่งไม่ควรเป็นแบบนั้นเพราะวัสดุของสินค้าไม่เหมือนกัน"* — this company makes
 * windows, louvres and doors from more than one material, so a material noun on a surface every
 * product shares is wrong for most of the catalogue.
 *
 * ── Why this file exists when `apps/web` already has one ────────────────────────
 *
 * `apps/web/src/i18n/catalogue.test.ts` pins the same rule and could not have caught the case
 * that prompted this one: a Thai sentence written into an **API service**, describing why one
 * cell of the forfeit policy is locked. It said "ยังไม่ได้ตัดอะลูมิเนียม", it was attached to
 * `production_confirmed` — a status — and it rendered on a company-settings screen shared by
 * every product. No catalogue was involved, so no catalogue test could see it.
 *
 * Two migrations had already been spent on this exact class of defect (0043, 0044). A rule
 * enforced in one app and not in another is a rule that comes back through the other one.
 *
 * ── The scope, and why it is drawn here ─────────────────────────────────────────
 *
 * Every Thai string this API *serves* is about an order, a quotation or a payment — none of them
 * is about one product, so none of them may name a material. What is deliberately **not**
 * scanned is code comments and test fixtures: a comment explaining the rule has to be able to
 * quote the word, and a fixture may legitimately call its product "ชุดครัวอะลูมิเนียม", which is
 * a product's own name and exactly what the rule permits.
 */

const MATERIAL_WORDS: readonly string[] = ['อะลูมิเนียม', 'อลูมิเนียม', 'กระจก'];

/** Thai string literals, ignoring comments — the text a person could actually be shown. */
function servedThai(source: string): readonly string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');

  return [...withoutComments.matchAll(/'([^'\\]*[\u0E00-\u0E7F][^'\\]*)'/gu)].map(
    (match) => match[1] ?? '',
  );
}

const filesUnder = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });

describe('no material noun on a surface every product shares', () => {
  it('⭐ holds for every Thai sentence this API serves', () => {
    const root = join(__dirname, '..', '..', 'src');
    const offences: string[] = [];

    for (const path of filesUnder(root)) {
      for (const sentence of servedThai(readFileSync(path, 'utf8'))) {
        for (const word of MATERIAL_WORDS) {
          if (!sentence.includes(word)) continue;
          offences.push(`${path.slice(root.length + 1)}: ${sentence}`);
        }
      }
    }

    expect(offences, offences.join('\n')).toStrictEqual([]);
  });

  it('⚠️ the scan can actually see a sentence, or it proves nothing', () => {
    /*
     * The anti-vacuity check. A regex that matched no Thai at all would pass the test above on
     * an empty list for ever — and the defect this file is about was invisible for exactly that
     * kind of reason.
     */
    const sample = servedThai(
      [
        "const a = 'ยืนยันผลิตแล้ว แต่ยังไม่เริ่มลงมือทำ';",
        "/* a comment saying อะลูมิเนียม is fine */",
        "const b = 'plain ascii';",
      ].join('\n'),
    );

    expect(sample).toContain('ยืนยันผลิตแล้ว แต่ยังไม่เริ่มลงมือทำ');
    expect(sample.some((text) => text.includes('อะลูมิเนียม'))).toBe(false);
  });

  it('⛔ would fail on the sentence that prompted it', () => {
    /* The literal as it was written, so the guard is checkable against the real defect. */
    const asShipped = "const reason = 'ยืนยันผลิตแล้วแต่ยังไม่ได้ตัดอะลูมิเนียม — ค่าใช้จ่ายจริงเริ่มที่ กำลังผลิต';";

    const caught = servedThai(asShipped).some((sentence) =>
      MATERIAL_WORDS.some((word) => sentence.includes(word)),
    );
    expect(caught).toBe(true);
  });
});
