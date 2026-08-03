import { useEffect, useState } from 'react';
import { Check, Copy, QrCode as QrIcon, Redo2, RotateCcw, Share2, Undo2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BottomSheet } from '../common/BottomSheet';
import { QrCode } from './QrCode';

interface ConfiguratorToolbarProps {
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isPristine: boolean;
  /** Absolute URL that reproduces the current configuration. */
  shareUrl: string;
}

/**
 * Undo, redo, reset, share and QR for the current configuration.
 *
 * Deliberately off the reference design in two ways. The buttons are square with
 * the project's 2px radius rather than circles, and the icons are chalk rather than
 * green — spec section 2 caps `--lime` at two appearances per screen, and those two
 * are already spent on the total and the add button. A row of five green circles
 * would both break that rule and read as five primary actions.
 */
export function ConfiguratorToolbar({
  onUndo,
  onRedo,
  onReset,
  canUndo,
  canRedo,
  isPristine,
  shareUrl,
}: ConfiguratorToolbarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z. Skipped while a field has focus so the
  // browser's own text undo keeps working inside the name and size inputs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;

      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;

      event.preventDefault();
      if (event.shiftKey) onRedo();
      else onUndo();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onUndo, onRedo]);

  const copyLink = () => {
    void navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true));
  };

  const openShare = () => {
    setShowQr(false);
    setSheetOpen(true);
  };

  const openQr = () => {
    setShowQr(true);
    setSheetOpen(true);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="จัดการการตั้งค่า">
        <ToolButton icon={Undo2} labelTh="ย้อนกลับ" onClick={onUndo} disabled={!canUndo} />
        <ToolButton icon={Redo2} labelTh="ทำซ้ำ" onClick={onRedo} disabled={!canRedo} />
        <ToolButton
          icon={RotateCcw}
          labelTh="กลับค่าเริ่มต้น"
          onClick={onReset}
          disabled={isPristine}
        />

        <span aria-hidden className="mx-1 h-6 w-px bg-line" />

        <ToolButton icon={Share2} labelTh="แชร์ลิงก์การตั้งค่านี้" onClick={openShare} />
        <ToolButton icon={QrIcon} labelTh="สร้าง QR ของลิงก์นี้" onClick={openQr} />
      </div>

      <BottomSheet
        open={sheetOpen}
        titleTh={showQr ? 'QR ของลิงก์นี้' : 'แชร์ลิงก์'}
        size="auto"
        onClose={() => setSheetOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-small text-chalk-2">
            ลิงก์นี้เปิดหน้าตั้งค่าพร้อมขนาดและตัวเลือกชุดเดียวกับที่เห็นอยู่
            ส่งให้ช่างหรือคนที่บ้านดูต่อได้เลย
          </p>

          {showQr ? (
            <div className="flex justify-center">
              <QrCode value={shareUrl} size={220} />
            </div>
          ) : null}

          <div className="flex min-w-0 items-center gap-2">
            <code className="numeric min-w-0 flex-1 truncate rounded-xs border border-line bg-panel-2 px-2 py-2 text-small text-chalk-2">
              {shareUrl}
            </code>
            <button
              type="button"
              onClick={copyLink}
              aria-label="คัดลอกลิงก์"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xs border border-line text-chalk-2 transition-colors duration-180 ease-out hover:border-line-2 hover:text-chalk"
            >
              {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
            </button>
          </div>

          <p aria-live="polite" className="text-caption text-chalk-3">
            {copied ? 'คัดลอกลิงก์แล้ว' : ' '}
          </p>

          {!showQr ? (
            <button
              type="button"
              onClick={() => setShowQr(true)}
              className="inline-flex min-h-11 items-center gap-2 self-start text-small text-chalk-2 underline underline-offset-4 transition-colors duration-180 ease-out hover:text-chalk"
            >
              <QrIcon size={15} aria-hidden />
              แสดงเป็น QR
            </button>
          ) : null}
        </div>
      </BottomSheet>
    </>
  );
}

function ToolButton({
  icon: Icon,
  labelTh,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  labelTh: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={labelTh}
      title={labelTh}
      className="flex h-11 w-11 items-center justify-center rounded-xs border border-line bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:border-line-2 hover:text-chalk disabled:opacity-30"
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}
