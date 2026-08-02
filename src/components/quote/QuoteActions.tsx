import { Copy, Pencil, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

interface QuoteActionsProps {
  editHref: string;
  onDuplicate: () => void;
  onRemove: () => void;
  /** Included in every label so a screen reader hears which line it is acting on. */
  nickname: string;
}

const ACTION_CLASS =
  'flex h-11 w-11 items-center justify-center rounded-xs border border-line text-chalk-2 transition-colors duration-180 ease-out hover:border-line-2 hover:text-chalk';

export function QuoteActions({ editHref, onDuplicate, onRemove, nickname }: QuoteActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <Link to={editHref} aria-label={`แก้ไขการตั้งค่า ${nickname}`} className={ACTION_CLASS}>
        <Pencil size={15} aria-hidden />
      </Link>
      <button
        type="button"
        onClick={onDuplicate}
        aria-label={`ทำซ้ำรายการ ${nickname}`}
        className={ACTION_CLASS}
      >
        <Copy size={15} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`ลบรายการ ${nickname}`}
        className={`${ACTION_CLASS} hover:border-danger hover:text-danger`}
      >
        <Trash2 size={15} aria-hidden />
      </button>
    </div>
  );
}

interface QtyStepperProps {
  qty: number;
  nickname: string;
  onChange: (qty: number) => void;
}

export function QuoteQtyStepper({ qty, nickname, onChange }: QtyStepperProps) {
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-xs border border-line">
      <button
        type="button"
        onClick={() => onChange(qty - 1)}
        disabled={qty <= 1}
        aria-label={`ลดจำนวน ${nickname} 1 ชิ้น`}
        className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
      >
        −
      </button>
      <output
        aria-label={`จำนวน ${nickname}`}
        className="numeric flex h-11 w-11 items-center justify-center bg-panel-2 text-body text-chalk"
      >
        {qty}
      </output>
      <button
        type="button"
        onClick={() => onChange(qty + 1)}
        disabled={qty >= 99}
        aria-label={`เพิ่มจำนวน ${nickname} 1 ชิ้น`}
        className="flex h-11 w-11 items-center justify-center bg-panel-2 text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
