/**
 * Geometry for the product elevation drawings.
 *
 * The drawings follow the convention the trade already uses on a shop drawing:
 * an outer frame, mullions between panels, and one symbol per panel saying how
 * that panel opens. Everything here is arithmetic, so the drawing can be checked
 * by test rather than by eye.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How a single panel operates — drives which symbol is drawn over it. */
export type PanelOperation =
  | 'fixed'
  | 'casement'
  | 'awning'
  | 'slide'
  | 'fold'
  | 'hang'
  | 'vertical';

/** What fills a panel. */
export type PanelInfill = 'glass' | 'louvre' | 'mesh';

export interface Elevation {
  panels: number;
  operation: PanelOperation;
  infill: PanelInfill;
  /** Relative widths, e.g. [2, 1] for a คู่แม่ลูก pair. Even split when absent. */
  panelWidths?: number[];
  /**
   * Indices of the panels that actually move, for sliding and hanging sets.
   * Absent means every panel moves. A "เดี่ยว" set has one moving leaf beside a
   * fixed one, and drawing an arrow on both would contradict its own name.
   */
  movingPanels?: number[];
}

/**
 * Even split unless the data says otherwise. A width list that does not match the
 * panel count is treated as absent: schema.ts rejects that combination at boot, so
 * reaching here means something is already wrong and a lopsided drawing would only
 * make it harder to see what.
 */
export function resolvePanelWidths(panels: number, widths: number[] | undefined): number[] {
  const count = Math.max(1, Math.floor(panels));

  if (widths && widths.length === count) return widths;
  return Array.from({ length: count }, () => 1);
}

/**
 * Lay panels across a frame, leaving `mullion` between neighbours.
 *
 * Widths are relative, so [2, 1] gives a two-thirds / one-third split of whatever
 * space is left after the mullions are taken out.
 */
export function panelRects(frame: Rect, widths: number[], mullion: number): Rect[] {
  const count = widths.length;
  if (count <= 1) return [{ ...frame }];

  const totalMullion = mullion * (count - 1);
  // A mullion wider than the opening would produce inverted rects; one honest
  // full-width panel beats a drawing that folds in on itself.
  if (totalMullion >= frame.width) return [{ ...frame }];

  const available = frame.width - totalMullion;
  const unitTotal = widths.reduce((sum, width) => sum + width, 0) || count;

  const rects: Rect[] = [];
  let x = frame.x;

  widths.forEach((width, index) => {
    const panelWidth = (available * width) / unitTotal;
    rects.push({ x, y: frame.y, width: panelWidth, height: frame.height });
    x += panelWidth + (index < count - 1 ? mullion : 0);
  });

  return rects;
}

const MIN_BLADES = 2;
const MAX_BLADES = 60;

/**
 * Blades for a louvre panel, at a roughly constant pitch.
 *
 * Capped because a very tall panel would otherwise be drawn with hundreds of
 * hairlines that merge into a solid block — the opposite of what the symbol means.
 */
export function louvreBladeCount(panelHeight: number, pitch: number): number {
  if (!Number.isFinite(panelHeight) || !Number.isFinite(pitch) || pitch <= 0) return MIN_BLADES;

  return Math.min(MAX_BLADES, Math.max(MIN_BLADES, Math.round(panelHeight / pitch)));
}
