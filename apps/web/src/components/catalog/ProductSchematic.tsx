'use client';

import type { ReactElement, ReactNode } from 'react';

import { useDisplayUnit } from '../../state/displayUnitContext';
import type { UnitVariants } from './unitVariants';

interface ProductSchematicProps {
  /** `0 0 w h`, computed on the server from the product's own proportions. */
  readonly viewBox: string;
  /**
   * The accessible name, pre-rendered in each of the five units — or `null` for a product
   * whose catalogue row has no width/height pair, which cannot happen and is handled.
   */
  readonly label: UnitVariants | null;
  /** What to say when there is no size to say. Already translated. */
  readonly unsizedLabel: string;
  /** The drawing itself, rendered on the server by `ElevationDrawing`. */
  readonly children: ReactNode;
}

/**
 * The `<svg>` shell of a catalogue thumbnail — and *only* the shell.
 *
 * `components/common/Schematic` owns the same drawing for the configurator's side of the
 * app and reads its accessible name from `useLocale()`. This one exists because the
 * catalogue's name has a second input the configurator's does not: the **display unit**.
 * `320 × 160 cm` and `≈126 × 63"` are the same window, and the card has to agree with the
 * configurator it leads to about which one the reader asked for.
 *
 * An `aria-label` is an attribute, so it cannot be a server-rendered child — the element
 * that carries it has to be created by whatever knows the unit. That is the entire reason
 * this file has `'use client'` on it, and it is deliberately the *only* thing that crossed:
 * `ElevationDrawing`, the panel geometry, the louvre blade counting and the opening
 * symbols all stay on the server and arrive here as `children`. Nothing in
 * `@wewin/core/elevation` reaches the browser for a catalogue page.
 *
 * The proportion is a `number` — a quotient of micrometres, which is the same drawing in
 * every unit — so no length crosses the boundary and nothing here can round one. A card
 * that re-derived a catalogue default in inches would be the failure plan 4.1 forbids.
 */
export function ProductSchematic({
  viewBox,
  label,
  unsizedLabel,
  children,
}: ProductSchematicProps): ReactElement {
  const { unit } = useDisplayUnit();

  return (
    <svg
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label={label === null ? unsizedLabel : label[unit]}
    >
      {children}
    </svg>
  );
}
