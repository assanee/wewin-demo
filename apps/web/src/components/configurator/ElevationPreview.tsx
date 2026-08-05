import type { LengthUnit } from '@wewin/core/units';
import { useElementSize } from '../../state/useElementSize';
import { useLocale } from '../../state/localeContext';
import { ElevationDrawing } from '../common/ElevationDrawing';
import type { Elevation } from '@wewin/core/elevation';

interface ElevationPreviewProps {
  /**
   * Width ÷ height. Only the proportion of the opening is drawn, so this is the
   * whole of what the geometry needs; the numbers on the dimension lines arrive
   * already formatted. Canonical lengths are `bigint` micrometres and must not
   * reach the SVG layer.
   */
  ratio: number;
  /** The width, formatted in the displayed unit — the numeral only, no unit. */
  widthLabel: string;
  /** The height, formatted the same way. */
  heightLabel: string;
  elevation: Elevation;
  profileHex: string;
  glassHex: string;
  /** Dimension lines turn danger-coloured while the measurements are out of bounds. */
  invalid?: boolean;
  /**
   * The unit both numerals are in, stated once at the foot of the drawing.
   *
   * Narrowed from `string` this round: the accessible name is a catalogue entry now,
   * and a drawing labelled with a unit the app does not have is not a thing that
   * should type-check.
   */
  unit: LengthUnit;
}

/* Fixed pixel gutters for the dimension lines, independent of the drawing scale. */
const GUTTER_BOTTOM = 34;
const GUTTER_RIGHT = 46;
const GUTTER_TOP = 10;
const GUTTER_LEFT = 10;
const ARROW = 5;
const TICK = 4;

/**
 * The signature element (spec section 2): a live shop-drawing elevation with real
 * dimension lines — extension lines, dimension lines, arrowheads and mono numerals.
 *
 * Everything is laid out in pixel space against the measured container rather than
 * in a centimetre viewBox. A 600 x 60 cm louver and a 180 x 220 cm door both need
 * legible 11px numerals and 1px hairlines; a scaled cm viewBox would shrink the type
 * along with the drawing and make the wide product unreadable. Only the frame's
 * proportion comes from the measurements, which is why that is all this is given —
 * the whole drawing scales, never crops.
 */
export function ElevationPreview({
  ratio,
  widthLabel,
  heightLabel,
  elevation,
  profileHex,
  glassHex,
  invalid = false,
  unit,
}: ElevationPreviewProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const { t } = useLocale();

  const boxW = size.width;
  const boxH = size.height;
  const ready = boxW > 0 && boxH > 0;

  // Space left over for the drawing once the dimension gutters are reserved.
  const availableW = Math.max(boxW - GUTTER_LEFT - GUTTER_RIGHT, 1);
  const availableH = Math.max(boxH - GUTTER_TOP - GUTTER_BOTTOM, 1);

  // A square is the honest fallback for a proportion that is not one: a zero or a
  // NaN here divides straight into the layout below and blanks the drawing.
  const proportion = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const fitByWidth = availableW / availableH <= proportion;

  const drawW = fitByWidth ? availableW : availableH * proportion;
  const drawH = fitByWidth ? availableW / proportion : availableH;

  const x0 = GUTTER_LEFT + (availableW - drawW) / 2;
  const y0 = GUTTER_TOP + (availableH - drawH) / 2;
  const x1 = x0 + drawW;
  const y1 = y0 + drawH;

  // Frame members read as a proportion of the opening, floored so they stay visible
  // on a very small drawing and capped so they do not swallow a narrow one.
  const frame = Math.min(Math.max(Math.min(drawW, drawH) * 0.05, 3), 14);

  const dimColor = invalid ? 'var(--color-danger)' : 'var(--color-blueprint)';
  const dimY = y1 + 20;
  const dimX = x1 + 26;

  return (
    <div
      ref={ref}
      className="h-full w-full"
      role="img"
      aria-label={t('drawing.elevation', {
        width: widthLabel,
        height: heightLabel,
        unit,
        invalid,
      })}
    >
      {ready ? (
        <svg width={boxW} height={boxH} viewBox={`0 0 ${boxW} ${boxH}`} aria-hidden>
          {/* The elevation itself is the same component the catalog thumbnails use,
              so the drawing a customer picked from and the one they configure can
              never disagree. This adds only the dimensioning around it. */}
          <ElevationDrawing
            frame={{ x: x0, y: y0, width: drawW, height: drawH }}
            elevation={elevation}
            profileHex={profileHex}
            glassHex={glassHex}
            frameWeight={frame}
            lineWeight={1}
            bladePitch={12}
          />

          {/* ---- Width dimension, below the drawing ---- */}
          <g stroke={dimColor} strokeWidth={1} className="transition-[stroke] duration-180 ease-out">
            {/* Extension lines stop short of the object, as they do on a real drawing. */}
            <line x1={x0} y1={y1 + 4} x2={x0} y2={dimY + TICK} />
            <line x1={x1} y1={y1 + 4} x2={x1} y2={dimY + TICK} />
            <line x1={x0} y1={dimY} x2={x1} y2={dimY} />
          </g>
          <polygon points={`${x0},${dimY} ${x0 + ARROW * 2},${dimY - ARROW} ${x0 + ARROW * 2},${dimY + ARROW}`} fill={dimColor} />
          <polygon points={`${x1},${dimY} ${x1 - ARROW * 2},${dimY - ARROW} ${x1 - ARROW * 2},${dimY + ARROW}`} fill={dimColor} />
          <text
            x={(x0 + x1) / 2}
            y={dimY - 6}
            textAnchor="middle"
            fill={dimColor}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
          >
            {widthLabel}
          </text>

          {/* ---- Height dimension, right of the drawing ---- */}
          <g stroke={dimColor} strokeWidth={1} className="transition-[stroke] duration-180 ease-out">
            <line x1={x1 + 4} y1={y0} x2={dimX + TICK} y2={y0} />
            <line x1={x1 + 4} y1={y1} x2={dimX + TICK} y2={y1} />
            <line x1={dimX} y1={y0} x2={dimX} y2={y1} />
          </g>
          <polygon points={`${dimX},${y0} ${dimX - ARROW},${y0 + ARROW * 2} ${dimX + ARROW},${y0 + ARROW * 2}`} fill={dimColor} />
          <polygon points={`${dimX},${y1} ${dimX - ARROW},${y1 - ARROW * 2} ${dimX + ARROW},${y1 - ARROW * 2}`} fill={dimColor} />
          <text
            x={dimX + 8}
            y={(y0 + y1) / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={dimColor}
            transform={`rotate(-90 ${dimX + 8} ${(y0 + y1) / 2})`}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
          >
            {heightLabel}
          </text>

          {/* Unit note, bottom left — a drawing always states its units. */}
          <text
            x={GUTTER_LEFT}
            y={boxH - 6}
            fill="var(--color-chalk-3)"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
          >
            {t('drawing.unitNote', { unit })}
          </text>
        </svg>
      ) : null}
    </div>
  );
}
