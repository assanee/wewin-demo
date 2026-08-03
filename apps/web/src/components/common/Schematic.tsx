import type { Elevation } from '@wewin/core/elevation';
import { ElevationDrawing } from './ElevationDrawing';

interface SchematicProps {
  /**
   * Width ÷ height. A proportion, not a measurement — the drawing has no scale, so
   * this is all it ever needed. Canonical lengths are `bigint` micrometres and must
   * not reach the SVG layer: `Math.max(3_200_000n, 1)` throws.
   */
  ratio: number;
  /** The size written out for the accessible name, e.g. "320 × 160 cm". */
  sizeLabel: string;
  elevation: Elevation;
  profileHex: string;
  glassHex: string;
  /** Frame thickness as a fraction of the shorter side. */
  frameRatio?: number;
}

/**
 * The shorter side of every schematic, in viewBox units.
 *
 * The drawing used to be laid out in centimetres, but every weight below was a
 * multiple of the shorter side already, so the real size never did anything the
 * proportion does not. Fixing the shorter side means the viewBox says what the
 * numbers mean: hundredths of the shorter side.
 */
const SHORT_SIDE = 100;

/**
 * A proportional elevation, drawn from the product's own proportions and its
 * elevation data — no stored artwork anywhere.
 *
 * There is no product photography in this prototype, and hand-drawing a thumbnail
 * per product would be exactly the per-product hardcoding spec section 0 forbids.
 * A fourth product gets a correct drawing, with the right number of panels and the
 * right opening symbol, the moment it is added to products.ts.
 *
 * Unlike ElevationPreview this carries no dimension lines: at thumbnail size their
 * gutters and 11px numerals collide into noise. Dimensions belong on the big
 * drawing, once.
 */
export function Schematic({
  ratio,
  sizeLabel,
  elevation,
  profileHex,
  glassHex,
  frameRatio = 0.045,
}: SchematicProps) {
  // A square is the honest fallback for a proportion that is not one: a zero or a
  // NaN width would otherwise collapse the viewBox and take the whole card with it.
  const proportion = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;

  // The viewBox carries the true aspect ratio, so the browser scales the whole
  // drawing rather than distorting or cropping it (spec section 8).
  const w = proportion >= 1 ? SHORT_SIDE * proportion : SHORT_SIDE;
  const h = proportion >= 1 ? SHORT_SIDE : SHORT_SIDE / proportion;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label={sizeLabel === '' ? 'ภาพร่างสัดส่วน' : `ภาพร่างสัดส่วน ${sizeLabel}`}
    >
      <ElevationDrawing
        frame={{ x: 0, y: 0, width: w, height: h }}
        elevation={elevation}
        profileHex={profileHex}
        glassHex={glassHex}
        frameWeight={SHORT_SIDE * frameRatio}
        /* Was floored at 0.4 of a centimetre so a small product kept a visible
           hairline. In a viewBox scaled to the shorter side there is no small
           product left for the floor to catch, so it is gone rather than ported. */
        lineWeight={SHORT_SIDE * 0.006}
        bladePitch={SHORT_SIDE * 0.075}
      />
    </svg>
  );
}
