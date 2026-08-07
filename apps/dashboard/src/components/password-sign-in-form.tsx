'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';

import { apiJson } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Email and password, for staff.
 *
 * ── What this component must not do ──────────────────────────────────────────────
 *
 * **It never stores the access token itself.** The response carries one, and the obvious
 * next line is `setAccessToken(body.accessToken)` — which would make this the second place
 * in the app that decides what "signed in" means. The refresh cookie the API just set is the
 * durable half; `refreshSession()` spends it exactly as a page load would, so a form sign-in
 * and a reload converge on one state by one path. The token in the body is ignored here on
 * purpose, and the decoder below reads only enough to prove the response was the right shape.
 *
 * **It never explains a refusal beyond what the API said.** The API answers one sentence for
 * five different situations — no such account, no password set, suspended, closed, wrong
 * password — precisely so that a stranger cannot use this form to discover which addresses
 * belong to staff. Any friendly elaboration here ("check your email address") would hand
 * back the distinction the API spent that design avoiding.
 */

interface SignInResponse {
  readonly accessTokenExpiresAt: string;
}

/**
 * Enough of the body to know the endpoint answered, and nothing more.
 *
 * `accessToken` is deliberately not read. A decoder that pulled it out would be a decoder
 * somebody later "uses", and the whole point above is that this component does not hold it.
 */
function decodeSignIn(body: unknown): SignInResponse {
  if (typeof body !== 'object' || body === null || !('accessTokenExpiresAt' in body)) {
    throw new Error('auth/password: expected { accessTokenExpiresAt }');
  }
  return { accessTokenExpiresAt: String((body as { accessTokenExpiresAt: unknown }).accessTokenExpiresAt) };
}

export function PasswordSignInForm() {
  const { refreshSession } = useSession();
  const emailId = useId();
  const passwordId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    try {
      await apiJson('/auth/password', decodeSignIn, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        /*
         * `anonymous` — there is no session yet by definition. Without it the client attaches
         * a stale access token and, on the 401 this endpoint returns for a wrong password,
         * silently retries the whole sign-in a second time. Two argon2 verifications and two
         * marks against the throttle for one wrong keystroke.
         */
        anonymous: true,
      });

      /*
       * Not `router.push`. `SignInPanel` already watches for `signed-in` and navigates to
       * `?next=`, which is the path that also handles somebody arriving here with a live
       * session. Navigating from here as well would be two components racing to decide where
       * this browser goes.
       */
      await refreshSession();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? cause.message
          : 'ติดต่อระบบไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่',
      );
      // The password field is *not* cleared. Clearing it is the reflex, and it punishes the
      // person who mistyped one character by making them type the whole passphrase again.
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      {problem !== null && (
        <Alert variant="destructive">
          <AlertTitle>เข้าสู่ระบบไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={emailId}>อีเมล</Label>
        <Input
          id={emailId}
          name="email"
          type="email"
          /*
           * `username` and not `email`: it is what password managers look for on a sign-in
           * form, and a manager that cannot find the field is a person typing a passphrase
           * by hand — which is how short passwords get chosen.
           */
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={passwordId}>รหัสผ่าน</Label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
      </div>

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
      </Button>

      {/*
        ⚠️ Always visible, never only after a failure.

        The tempting version reveals this link once somebody has got their password wrong,
        which reads as helpful and is not: the person who most needs it is the one who
        already knows they have forgotten, and making them fail first to be offered the way
        out is a worse form of the same problem as the reset endpoints having had no page at
        all — the capability exists and nobody can reach it.
      */}
      <Link
        href="/forgot-password"
        className="text-muted-foreground hover:text-foreground self-center text-sm underline-offset-4 hover:underline"
      >
        ลืมรหัสผ่าน?
      </Link>
    </form>
  );
}
