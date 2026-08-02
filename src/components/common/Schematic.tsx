interface SchematicProps {
  widthCm: number;
  heightCm: number;
  profileHex: string;
  glassHex: string;
  /** Frame thickness as a fraction of the shorter side. */
  frameRatio?: number;
}

/**
 * A proportional elevation outline, drawn from the product's own measurements.
 *
 * There is no product photography in this prototype, and hand-drawing a thumbnail
 * per product would be exactly the per-product hardcoding spec section 0 forbids.
 * This derives the drawing from the data instead, so a fourth product gets a correct
 * thumbnail the moment it is added to products.ts.
 *
 * Phase 3's ElevationPreview builds on the same geometry, adding dimension lines.
 */
export function Schematic({
  widthCm,
  heightCm,
  profileHex,
  glassHex,
  frameRatio = 0.045,
}: SchematicProps) {
  // The viewBox carries the true aspect ratio, so the browser scales the whole
  // drawing rather than distorting or cropping it (spec section 8).
  const w = Math.max(widthCm, 1);
  const h = Math.max(heightCm, 1);
  const frame = Math.min(w, h) * frameRatio;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label={`ภาพร่างสัดส่วน ${widthCm} × ${heightCm} เซนติเมตร`}
    >
      <rect x={0} y={0} width={w} height={h} fill={glassHex} fillOpacity={0.14} />
      <rect
        x={frame / 2}
        y={frame / 2}
        width={w - frame}
        height={h - frame}
        fill="none"
        stroke={profileHex}
        strokeWidth={frame}
      />
      {/* Centre marks — the convention on a shop drawing for an unfixed opening. */}
      <line
        x1={w / 2}
        y1={frame}
        x2={w / 2}
        y2={h - frame}
        stroke="currentColor"
        strokeWidth={Math.max(w, h) * 0.002}
        strokeDasharray={`${h * 0.05} ${h * 0.03}`}
        opacity={0.35}
      />
    </svg>
  );
}
