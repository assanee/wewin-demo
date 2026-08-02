import type { Elevation } from '../../lib/elevation';
import { ElevationDrawing } from './ElevationDrawing';

interface SchematicProps {
  widthCm: number;
  heightCm: number;
  elevation: Elevation;
  profileHex: string;
  glassHex: string;
  /** Frame thickness as a fraction of the shorter side. */
  frameRatio?: number;
}

/**
 * A proportional elevation, drawn from the product's own measurements and its
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
  widthCm,
  heightCm,
  elevation,
  profileHex,
  glassHex,
  frameRatio = 0.045,
}: SchematicProps) {
  // The viewBox carries the true aspect ratio, so the browser scales the whole
  // drawing rather than distorting or cropping it (spec section 8).
  const w = Math.max(widthCm, 1);
  const h = Math.max(heightCm, 1);
  const shorter = Math.min(w, h);
  const frameWeight = shorter * frameRatio;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label={`ภาพร่างสัดส่วน ${widthCm} × ${heightCm} เซนติเมตร`}
    >
      <ElevationDrawing
        frame={{ x: 0, y: 0, width: w, height: h }}
        elevation={elevation}
        profileHex={profileHex}
        glassHex={glassHex}
        frameWeight={frameWeight}
        lineWeight={Math.max(shorter * 0.006, 0.4)}
        bladePitch={shorter * 0.075}
      />
    </svg>
  );
}
