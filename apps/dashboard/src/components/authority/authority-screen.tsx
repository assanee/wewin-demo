'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { failureMessage } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';

import {
  listAuthorityGroups,
  listAuthorityLimits,
  type AuthorityGroupView,
} from './authority-limits-api';
import AuthorityLimitsPanel, { type AuthorityLimitsState } from './authority-limits-panel';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ The ceiling screen, on a page of its own — `groups.read`, and nothing else.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **Why this is not a tab on `/users` any more, which is the whole reason this file
 * exists.**
 *
 * It began as a third tab beside ผู้ใช้ and กลุ่มและสิทธิ์, on the reasoning that authority
 * attaches to a group and groups are administered there. The consequence was invisible from
 * inside that page and fatal from outside it: `/users` carries `requires: ['users.read']` in
 * the nav and its loader is `Promise.all([listUsers(), listGroups()])`, so reaching the ceiling
 * table meant holding `users.read` — sight of the entire staff directory, which this project
 * treats as a PDPA-relevant disclosure. `groups.write` is held by nobody at boot, so the *first
 * person ever granted it* could not open the screen their permission exists for. A reviewer
 * proved it by making such a user: the nav showed two entries, and navigating to `/users`
 * directly produced a raw English `Missing permission: users.read.` on an all-Thai page.
 *
 * So the two reads this screen needs are both `groups.read`:
 *
 *     GET /quotes/authority/limits    the ceilings
 *     GET /quotes/authority/groups    the roles the picker offers
 *
 * The second exists **because of this split** — see `authority.controller.ts`. Nothing in this
 * folder imports from `components/users/`, and that is the invariant to keep: one `Group` type
 * borrowed back from `user-api.ts` would silently reintroduce the `users.read` dependency
 * through a type that happens to be populated by a `users.read` endpoint.
 *
 * ── The two loads are separate, and their failures are separate ──────────────────
 *
 * A 403 or a timeout on the roster must not take the table down with it: reading the ceilings
 * and their history is the larger half of what a `groups.read` holder came for, and the roster
 * is only needed to grant a *new* one. `AuthorityLimitsPanel` already withholds the
 * กำหนดเพดาน button until its own state is `ready`, so an empty roster degrades to "you can
 * read everything and add nothing" rather than to a blank page.
 *
 * ── The permission gate is resolved here and passed down as props ────────────────
 *
 * `AuthorityLimitsPanel` never calls `useSession()` itself. That is what lets it be rendered
 * under `environment: 'node'` with `renderToStaticMarkup` in `authority-limits.test.ts` — a
 * real `SessionProvider` would sit at `loading` forever, because static rendering never runs
 * effects. The gate that enforces anything is `@RequirePermissions` on the route; this decides
 * which controls exist.
 */
export function AuthorityScreen() {
  const { can } = useSession();

  const mayRead = can('groups.read');
  const mayWrite = can('groups.write');

  const [limits, setLimits] = useState<AuthorityLimitsState>({ status: 'loading' });
  const [groups, setGroups] = useState<readonly AuthorityGroupView[]>([]);

  async function reload(): Promise<void> {
    if (!mayRead) return;
    try {
      const list = await listAuthorityLimits();
      setLimits({ status: 'ready', limits: list.limits, isFailClosed: list.isFailClosed });
    } catch (cause) {
      setLimits({ status: 'failed', problem: failureMessage(cause) });
    }
  }

  useEffect(() => {
    void reload();

    /* Separate, so that losing the roster does not lose the table. See the header. */
    if (mayRead) {
      listAuthorityGroups().then(setGroups, () => setGroups([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  /*
   * The pre-emptive Thai sentence, not a 403 rendered from the server — the same position
   * `product-editor.tsx` and `quote-editor.tsx` take. Somebody who cannot read this table
   * should be told what is missing, in Thai, rather than shown an empty screen or an English
   * refusal from a request that need never have been made.
   */
  if (!mayRead) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>บัญชีของคุณไม่มีสิทธิ์ดูเพดานอำนาจอนุมัติ</AlertTitle>
        <AlertDescription>
          ต้องให้ผู้ดูแลระบบเพิ่มสิทธิ์ groups.read ให้กลุ่มของคุณก่อน จึงจะเห็นว่าบทบาทใดลดราคาได้เท่าไร
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <AuthorityLimitsPanel
      state={limits}
      groups={groups}
      editable={mayWrite}
      onChanged={reload}
    />
  );
}
