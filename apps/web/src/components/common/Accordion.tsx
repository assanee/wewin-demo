import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface AccordionProps {
  /**
   * Already translated by the caller.
   *
   * Not a key: this component is generic furniture and the set of headings it will
   * ever carry is open, so taking a `PlainKey` would make every new caller widen a
   * union in `keys.ts`. The `Th` suffix had to go either way — a prop whose name says
   * Thai and whose value is whatever the page is written in is a lie the next reader
   * has to discover, which is the same rename `OptionState.reason` took in core.
   */
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function Accordion({ title, children, defaultOpen = false }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className="border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center justify-between gap-2 text-start text-body text-chalk-2 transition-colors duration-180 ease-out hover:text-chalk"
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown
          size={16}
          aria-hidden
          className={`shrink-0 transition-transform duration-180 ease-out ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div id={panelId} className="pb-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}
