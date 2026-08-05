import { AlertTriangle, CircleAlert } from 'lucide-react';
import type { Issue } from '@wewin/core/validation';
import { useLocale } from '../../state/localeContext';

interface IssuePanelProps {
  issues: Issue[];
  /** Set after a blocked add attempt so the summary can take focus. */
  headingRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * The panel plan section 5 was written about.
 *
 * `issue.messageTh` was a Thai sentence `validation.ts` built out of a template
 * literal, and this component printed it. It is `issue.message` now — a key and its
 * values — and the sentence is assembled here, in the layer that knows the language.
 * Nothing about the layout moved; what changed is that one `Issue` can be read in
 * eight languages, and that the numbers inside it arrive as `bigint` micrometres
 * rather than as text somebody upstream had already formatted.
 */
export function IssuePanel({ issues, headingRef }: IssuePanelProps) {
  const { message } = useLocale();

  if (issues.length === 0) return null;

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  // `lang="th"` when this locale has no renderer and the Thai one stood in. A German
  // page announcing a Thai sentence in a German voice is noise; the attribute costs
  // one word and fixes it. Same argument as `CatalogText`.
  const line = (issue: Issue) => {
    const rendered = message(issue.message);
    return (
      <span className="min-w-0" {...(rendered.fallback ? { lang: 'th' } : {})}>
        {rendered.text}
      </span>
    );
  };

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
          {line(issue)}
        </p>
      ))}

      {warnings.map((issue) => (
        <p
          key={issue.ruleId}
          className="flex min-w-0 items-start gap-2 rounded-xs border border-warn/40 bg-warn/10 px-3 py-2 text-small text-warn"
        >
          <AlertTriangle size={15} aria-hidden className="mt-[3px] shrink-0" />
          {line(issue)}
        </p>
      ))}
    </div>
  );
}
