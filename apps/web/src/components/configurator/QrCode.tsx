import { useEffect, useState } from 'react';
import { useLocale } from '../../state/localeContext';

interface QrCodeProps {
  value: string;
  /** Rendered size in px. The matrix is vector, so this only sets the box. */
  size?: number;
}

const QUIET_ZONE = 4; // modules — the spec's minimum margin, or scanners struggle

/**
 * A QR code for the share link, drawn as SVG so it stays crisp at any size and
 * needs no canvas.
 *
 * Dark modules on a light ground, not the page's dark theme inverted. Inverted
 * codes are legal but a good number of scanners — especially older phone cameras —
 * will not read them, and a QR that fails to scan is worse than no QR at all. The
 * two colours are still ours: ink modules on a chalk card.
 *
 * The encoder is loaded on demand: it is only needed once someone opens the share
 * sheet, and there is no reason for it to sit in the bundle every other visitor
 * downloads.
 */
export function QrCode({ value, size = 200 }: QrCodeProps) {
  const [matrix, setMatrix] = useState<boolean[][] | null>(null);
  const [failed, setFailed] = useState(false);
  const { t } = useLocale();

  useEffect(() => {
    let cancelled = false;
    setMatrix(null);
    setFailed(false);

    import('qrcode-generator')
      .then(({ default: qrcode }) => {
        if (cancelled) return;

        // Type 0 = pick the smallest version that fits. 'M' corrects ~15% damage,
        // which is the usual choice for a screen where nothing is going to smudge.
        const qr = qrcode(0, 'M');
        qr.addData(value);
        qr.make();

        const count = qr.getModuleCount();
        setMatrix(
          Array.from({ length: count }, (_, row) =>
            Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <p className="text-small text-chalk-3">{t('qr.failed')}</p>
    );
  }

  if (!matrix) {
    return (
      <div
        aria-hidden
        className="rounded-xs border border-line bg-panel-2"
        style={{ width: size, height: size }}
      />
    );
  }

  const count = matrix.length;
  const span = count + QUIET_ZONE * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={t('qr.alt')}
      className="rounded-xs"
    >
      <rect width={span} height={span} fill="var(--color-chalk)" />
      {matrix.map((row, y) =>
        row.map((dark, x) =>
          dark ? (
            <rect
              key={`${x}-${y}`}
              x={x + QUIET_ZONE}
              y={y + QUIET_ZONE}
              width={1}
              height={1}
              fill="var(--color-ink)"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
