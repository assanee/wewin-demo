import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ A DIALOG TALLER THAN THE SCREEN MUST STILL BE SAVEABLE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `DialogContent` is centred with `top-1/2 -translate-y-1/2`. As shadcn generated it, it
 * carried **no height bound and no overflow**, so a dialog taller than the viewport hung off
 * both ends with nothing to scroll: measured at 884px in a 757px viewport, top at y=-63,
 * footer at y=772. `document.elementFromPoint` over the Save button returned `null`, because
 * the button was below the bottom edge of the window.
 *
 * The consequence is not a clipped corner. Staff edit a setting, click where Save is, nothing
 * happens, no error appears, and the change is gone — with the page behind frozen by the
 * modal so it reads as the app having hung. It was found on `tax-country-dialog`, where
 * choosing a currency *enables* two fields whose long descriptions push the footer past the
 * fold, so the dialog works right up until the moment somebody uses the control it exists for.
 *
 * ── ⚠️ Why this test reads a file instead of rendering ────────────────────────
 *
 * `vitest.config.ts` sets `environment: 'node'` for this package, deliberately: there is no
 * jsdom, and jsdom would not help anyway — it does not do layout, so `getBoundingClientRect`
 * is all zeroes and the very overflow this guards against is invisible to it. A test that
 * mounted the dialog and asserted the footer was reachable would pass in *every* case,
 * including the broken one. That is the "test that cannot fail" this repository keeps finding.
 *
 * So the assertion is on the class list, which is the thing that actually carries the
 * guarantee, and the real check is the browser — one bound, two properties, in a file whose
 * whole job is to be noticed when somebody regenerates the component from shadcn and quietly
 * drops them again.
 */

const dialogSource = readFileSync('src/components/ui/dialog.tsx', 'utf8');

/** The `cn(...)` class string on `DialogPrimitive.Content`, and only that one. */
function dialogContentClasses(): string {
  const marker = 'data-slot="dialog-content"';
  const at = dialogSource.indexOf(marker);
  expect(at, 'dialog-content slot not found — has the component been restructured?').toBeGreaterThan(-1);

  /* The first double-quoted string after the slot marker is the class list. */
  const open = dialogSource.indexOf('"', dialogSource.indexOf('className={cn(', at));
  const close = dialogSource.indexOf('"', open + 1);
  return dialogSource.slice(open + 1, close);
}

describe('⚠️ a dialog can never strand its own footer off-screen', () => {
  it('bounds its height to the viewport', () => {
    /*
     * `dvh` and not `vh`: on a phone `vh` ignores the browser chrome, which puts the footer
     * back under the address bar — the same failure, on the device where it is hardest to
     * notice.
     */
    expect(dialogContentClasses()).toMatch(/max-h-\[calc\(100dvh-[^\]]+\)\]/u);
  });

  it('scrolls when its content is taller than that bound', () => {
    /*
     * The bound alone would clip the footer instead of stranding it — still unreachable, and
     * now invisible too. Both halves or neither.
     */
    expect(dialogContentClasses()).toMatch(/overflow-y-auto/u);
  });

  it('⚠️ still centres, because the bound is what makes centring safe', () => {
    /*
     * If somebody "fixes" the overflow by dropping the centring and pinning the dialog to the
     * top, these two rules become dead weight and the next reader deletes them. This pins the
     * combination that was actually reasoned about.
     */
    const classes = dialogContentClasses();
    expect(classes).toContain('top-1/2');
    expect(classes).toContain('-translate-y-1/2');
  });
});

/**
 * The two dialogs this was found on and the one it matters most for.
 *
 * `authority-limit-dialog` decides who may concede how much money; a save silently lost there
 * is a ceiling somebody believes they raised. It uses the same `DialogContent` and the same
 * `SelectField`-then-footer shape, so it was affected by exactly the same bug and is fixed by
 * exactly the same line — which is the argument for fixing the primitive rather than the two
 * dialogs that happened to be noticed.
 */
describe('the dialogs that share the primitive', () => {
  const usesSharedDialogContent = (path: string): boolean =>
    /from ['"]@\/components\/ui\/dialog['"]/u.test(readFileSync(path, 'utf8'));

  it.each([
    ['src/components/organisation/tax-country-dialog.tsx'],
    ['src/components/authority/authority-limit-dialog.tsx'],
  ])('%s renders through the shared DialogContent', (path) => {
    expect(usesSharedDialogContent(path)).toBe(true);
  });
});
