import { AlertTriangle, CircleAlert } from 'lucide-react';
import type { Issue } from '@wewin/core/validation';

interface IssuePanelProps {
  issues: Issue[];
  /** Set after a blocked add attempt so the summary can take focus. */
  headingRef?: React.RefObject<HTMLDivElement | null>;
}

export function IssuePanel({ issues, headingRef }: IssuePanelProps) {
  if (issues.length === 0) return null;

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return (
    <div
      ref={headingRef}
      tabIndex={-1}
      // Announced as they appear, without stealing focus from the control being used.
      role="status"
      aria-live="polite"
      className="flex flex-col gap-2 outline-none"
    >
      {errors.map((issue) => (
        <p
          key={issue.ruleId}
          className="flex min-w-0 items-start gap-2 rounded-xs border border-danger/40 bg-danger/10 px-3 py-2 text-small text-danger"
        >
          <CircleAlert size={15} aria-hidden className="mt-[3px] shrink-0" />
          <span className="min-w-0">{issue.messageTh}</span>
        </p>
      ))}

      {warnings.map((issue) => (
        <p
          key={issue.ruleId}
          className="flex min-w-0 items-start gap-2 rounded-xs border border-warn/40 bg-warn/10 px-3 py-2 text-small text-warn"
        >
          <AlertTriangle size={15} aria-hidden className="mt-[3px] shrink-0" />
          <span className="min-w-0">{issue.messageTh}</span>
        </p>
      ))}
    </div>
  );
}
