import { Fragment } from 'react';
import {
  louvreBladeCount,
  panelRects,
  resolvePanelWidths,
  type Elevation,
  type Rect,
} from '@wewin/core/elevation';

interface ElevationDrawingProps {
  /** Where to draw, in the parent SVG's own units. */
  frame: Rect;
  elevation: Elevation;
  profileHex: string;
  glassHex: string;
  /** Stroke width for the outer frame and mullions. */
  frameWeight: number;
  /** Hairline weight for symbols and blades. */
  lineWeight: number;
  /** Blade pitch in the same units as `frame`. */
  bladePitch: number;
}

/**
 * A front elevation drawn the way the trade draws one: outer frame, mullions
 * between panels, and a symbol per panel saying how that panel opens.
 *
 * Shared by the catalog thumbnail and the live configurator preview so the two can
 * never disagree about what a product looks like. It renders SVG children only —
 * the caller owns the <svg> and its coordinate system, which is what lets the
 * preview place this inside a pixel-space drawing alongside its dimension lines.
 *
 * Symbols follow the drawing convention rather than being invented: a diagonal
 * cross for a side-hung casement, a line along the opening edge for an awning,
 * arrows along the travel for sliding and hanging leaves. They are drawn in
 * `--chalk-3`, not `--blueprint` (reserved for dimensions) and not `--danger`
 * (reserved for validation), so no colour carries two meanings.
 */
export function ElevationDrawing({
  frame,
  elevation,
  profileHex,
  glassHex,
  frameWeight,
  lineWeight,
  bladePitch,
}: ElevationDrawingProps) {
  const widths = resolvePanelWidths(elevation.panels, elevation.panelWidths);

  // The opening sits inside the outer frame members.
  const opening: Rect = {
    x: frame.x + frameWeight,
    y: frame.y + frameWeight,
    width: Math.max(frame.width - frameWeight * 2, 1),
    height: Math.max(frame.height - frameWeight * 2, 1),
  };

  const rects = panelRects(opening, widths, frameWeight);
  const symbol = 'var(--color-chalk-3)';

  return (
    <g>
      {/* Infill first, so frame members read as sitting on top of it. */}
      {rects.map((rect, index) => (
        <Fragment key={index}>
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            fill={elevation.infill === 'louvre' ? profileHex : glassHex}
            fillOpacity={elevation.infill === 'glass' ? 0.16 : 0.1}
            className="transition-[fill] duration-180 ease-out"
          />

          {elevation.infill === 'louvre' ? (
            <Blades rect={rect} pitch={bladePitch} weight={lineWeight} colour={profileHex} />
          ) : null}

          {elevation.infill === 'mesh' ? (
            <Mesh rect={rect} pitch={bladePitch} weight={lineWeight} colour={symbol} />
          ) : null}

          <OperationSymbol
            rect={rect}
            operation={
              elevation.movingPanels && !elevation.movingPanels.includes(index)
                ? 'fixed'
                : elevation.operation
            }
            index={index}
            total={rects.length}
            weight={lineWeight}
            colour={symbol}
          />

          {/* Mullion between this panel and the next. */}
          {index < rects.length - 1 ? (
            <rect
              x={rect.x + rect.width}
              y={opening.y}
              width={frameWeight}
              height={opening.height}
              fill={profileHex}
              className="transition-[fill] duration-180 ease-out"
            />
          ) : null}
        </Fragment>
      ))}

      {/* Outer frame, stroked on its centreline so the outer edge lands exactly on
          the dimensioned opening. */}
      <rect
        x={frame.x + frameWeight / 2}
        y={frame.y + frameWeight / 2}
        width={Math.max(frame.width - frameWeight, 0)}
        height={Math.max(frame.height - frameWeight, 0)}
        fill="none"
        stroke={profileHex}
        strokeWidth={frameWeight}
        className="transition-[stroke] duration-180 ease-out"
      />
    </g>
  );
}

function Blades({
  rect,
  pitch,
  weight,
  colour,
}: {
  rect: Rect;
  pitch: number;
  weight: number;
  colour: string;
}) {
  const count = louvreBladeCount(rect.height, pitch);
  const step = rect.height / count;

  return (
    <g stroke={colour} strokeWidth={weight} opacity={0.75}>
      {Array.from({ length: count - 1 }, (_, i) => {
        const y = rect.y + step * (i + 1);
        return <line key={i} x1={rect.x} y1={y} x2={rect.x + rect.width} y2={y} />;
      })}
    </g>
  );
}

/** A coarse cross-hatch — enough to read as mesh without turning into a grey block. */
function Mesh({
  rect,
  pitch,
  weight,
  colour,
}: {
  rect: Rect;
  pitch: number;
  weight: number;
  colour: string;
}) {
  const step = Math.max(pitch, 2);
  const cols = Math.min(24, Math.max(2, Math.round(rect.width / step)));
  const rows = Math.min(24, Math.max(2, Math.round(rect.height / step)));

  return (
    <g stroke={colour} strokeWidth={weight} opacity={0.28}>
      {Array.from({ length: cols - 1 }, (_, i) => {
        const x = rect.x + (rect.width / cols) * (i + 1);
        return <line key={`v${i}`} x1={x} y1={rect.y} x2={x} y2={rect.y + rect.height} />;
      })}
      {Array.from({ length: rows - 1 }, (_, i) => {
        const y = rect.y + (rect.height / rows) * (i + 1);
        return <line key={`h${i}`} x1={rect.x} y1={y} x2={rect.x + rect.width} y2={y} />;
      })}
    </g>
  );
}

function OperationSymbol({
  rect,
  operation,
  index,
  total,
  weight,
  colour,
}: {
  rect: Rect;
  operation: Elevation['operation'];
  index: number;
  total: number;
  weight: number;
  colour: string;
}) {
  const inset = Math.min(rect.width, rect.height) * 0.12;
  const x0 = rect.x + inset;
  const x1 = rect.x + rect.width - inset;
  const y0 = rect.y + inset;
  const y1 = rect.y + rect.height - inset;
  const midY = (y0 + y1) / 2;
  const midX = (x0 + x1) / 2;

  if (operation === 'fixed') return null;

  const stroke = { stroke: colour, strokeWidth: weight, fill: 'none' } as const;

  if (operation === 'casement' || operation === 'fold') {
    // A cross of both diagonals: the standard side-hung symbol. Folding leaves use
    // the same mark because each leaf is itself side-hung on its neighbour.
    return (
      <g {...stroke} opacity={0.8}>
        <line x1={x0} y1={y0} x2={x1} y2={y1} />
        <line x1={x1} y1={y0} x2={x0} y2={y1} />
      </g>
    );
  }

  if (operation === 'awning') {
    // Top-hung: the two diagonals meet at the bottom edge, which is the edge that
    // swings out. The heavier line along that edge is what distinguishes it from a
    // casement at a glance.
    return (
      <g {...stroke} opacity={0.8}>
        <line x1={x0} y1={y0} x2={midX} y2={y1} />
        <line x1={x1} y1={y0} x2={midX} y2={y1} />
        <line x1={x0} y1={y1} x2={x1} y2={y1} strokeWidth={weight * 2} />
      </g>
    );
  }

  if (operation === 'vertical') {
    const head = Math.min(rect.width, rect.height) * 0.06;
    return (
      <g opacity={0.8}>
        <line x1={midX} y1={y0} x2={midX} y2={y1} {...stroke} />
        <polygon points={`${midX},${y0} ${midX - head},${y0 + head * 2} ${midX + head},${y0 + head * 2}`} fill={colour} />
        <polygon points={`${midX},${y1} ${midX - head},${y1 - head * 2} ${midX + head},${y1 - head * 2}`} fill={colour} />
      </g>
    );
  }

  // slide / hang: an arrow along the travel. Leaves in the left half of the
  // opening are drawn travelling left, the rest right, which is how a
  // centre-opening set reads on a drawing.
  const toLeft = index < total / 2;
  const head = Math.min(rect.width, rect.height) * 0.07;
  const tipX = toLeft ? x0 : x1;
  const tailX = toLeft ? x1 : x0;
  const dir = toLeft ? 1 : -1;

  return (
    <g opacity={0.8}>
      <line x1={tailX} y1={midY} x2={tipX} y2={midY} {...stroke} />
      <polygon
        points={`${tipX},${midY} ${tipX + head * 2 * dir},${midY - head} ${tipX + head * 2 * dir},${midY + head}`}
        fill={colour}
      />
    </g>
  );
}
