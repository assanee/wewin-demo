'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { currentSession, signOut as endSession, type Session } from '../lib/auth/account';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ONE SESSION, ASKED FOR ONCE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **Spending the refresh cookie twice is a sign-out.** `POST /auth/refresh` rotates it, so
 * two components each asking "am I signed in?" in the same second produce two rotations, and
 * the second invalidates the first. `AccountGate` already carried that warning and avoided it
 * by handing its session down to its children — which worked for exactly as long as the cart
 * was the only place that asked.
 *
 * A header link that changes with the session is a second asker, so the question moves here
 * and is asked once, above every route.
 *
 * ── The first answer is always `checking` ────────────────────────────────────
 *
 * The refresh cookie is `__Host-` prefixed and belongs to the API's origin; this bundle cannot
 * read it. So the answer cannot come from storage and has to come over the network — and every
 * consumer has to render a third state rather than assuming signed out. Rendering "sign in"
 * first and correcting a moment later would flash it at somebody already signed in, and on a
 * prerendered page it is a hydration mismatch: the server and the first client render must
 * agree, and neither of them knows.
 */

export type SessionState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'signed-in'; readonly session: Session };

export interface SessionContextValue {
  readonly state: SessionState;
  /** Called by the sign-in and register forms once the API has answered. */
  readonly adopt: (session: Session) => void;
  readonly signOut: () => void;
}

const SessionCtx = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;

    void currentSession().then((session) => {
      if (cancelled) return;
      setState(session === null ? { kind: 'anonymous' } : { kind: 'signed-in', session });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = useCallback((session: Session) => {
    setState({ kind: 'signed-in', session });
  }, []);

  const signOut = useCallback(() => {
    /*
     * ⚠️ Local first, then the server. The customer pressed a button and the screen has to
     * answer; a network failure must not leave them looking at a signed-in page they asked to
     * leave. What the server call actually does is make the refresh cookie useless, so a
     * failure here means the session survives until it expires — worth a retry one day, not
     * worth blocking the UI on.
     */
    setState({ kind: 'anonymous' });
    void endSession();
  }, []);

  const value = useMemo<SessionContextValue>(() => ({ state, adopt, signOut }), [adopt, signOut, state]);

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionCtx);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
