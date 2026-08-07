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

/**
 * ⭐ Two shapes, and the discriminator is the presence of `mfaRequired`.
 *
 * A `kind` field would be tidier and the API does not send one, because the session shape
 * predates the second factor and adding a discriminator to it would break every existing
 * client for the benefit of a client that is being written now.
 */
type SignInResponse =
  | { readonly kind: 'session'; readonly accessTokenExpiresAt: string }
  | {
      readonly kind: 'challenge';
      /**
       * ⚠️ **This one *is* held**, unlike the access token.
       *
       * The comment above says the access token is deliberately untouched because the refresh
       * cookie is the durable half and `refreshSession()` spends it. A challenge has no
       * cookie — it exists for one round trip and has to be posted back by hand — so it lives
       * in this component's state for the length of one step and nowhere else. Not in
       * `sessionStorage`, not in a URL: a challenge in either would outlive the tab it was
       * meant for.
       */
      readonly challengeToken: string;
      readonly challengeExpiresAt: string;
    };

/**
 * Enough of the body to know the endpoint answered, and nothing more.
 *
 * `accessToken` is deliberately not read. A decoder that pulled it out would be a decoder
 * somebody later "uses", and the whole point above is that this component does not hold it.
 */
function decodeSignIn(body: unknown): SignInResponse {
  if (typeof body !== 'object' || body === null) {
    throw new Error('auth/password: expected an object');
  }

  const shape = body as Record<string, unknown>;

  if (shape['mfaRequired'] === true) {
    if (typeof shape['challengeToken'] !== 'string') {
      throw new Error('auth/password: a challenge with no token');
    }
    return {
      kind: 'challenge',
      challengeToken: shape['challengeToken'],
      challengeExpiresAt: String(shape['challengeExpiresAt']),
    };
  }

  if (!('accessTokenExpiresAt' in shape)) {
    throw new Error('auth/password: expected { accessTokenExpiresAt } or { mfaRequired }');
  }

  return { kind: 'session', accessTokenExpiresAt: String(shape['accessTokenExpiresAt']) };
}

export function PasswordSignInForm() {
  const { refreshSession } = useSession();
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * The second step, when there is one. Held here and nowhere else — see the note on
   * `challengeToken` above: a challenge in `sessionStorage` or a URL outlives the tab it was
   * meant for.
   */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    try {
      const outcome = await apiJson('/auth/password', decodeSignIn, {
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
       * ⭐ A challenge is not a failure and not a session. The password was right; the
       * account has a second factor, and the form has a second step.
       */
      if (outcome.kind === 'challenge') {
        setChallenge(outcome.challengeToken);
        setBusy(false);
        return;
      }

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

  /**
   * Step two.
   *
   * ⚠️ On refusal the form goes **back to the password step**, and that is deliberate rather
   * than tidy. The API answers one sentence for every way this can fail — expired challenge,
   * wrong code, spent code, MFA turned off in between — so the client cannot tell "try
   * another code" from "your challenge died". Offering another attempt against a challenge
   * that may already be dead is a loop somebody spends three codes in. Starting over costs
   * one password and always works.
   */
  async function onCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (challenge === null) return;

    setBusy(true);
    setProblem(null);

    try {
      await apiJson('/auth/mfa', () => null, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge, code }),
        anonymous: true,
      });

      await refreshSession();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? cause.message
          : 'ติดต่อระบบไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่',
      );
      setChallenge(null);
      setCode('');
      setPassword('');
      setBusy(false);
    }
  }

  if (challenge !== null) {
    return (
      <form onSubmit={(event) => void onCode(event)} className="flex flex-col gap-3">
        {problem !== null && (
          <Alert variant="destructive">
            <AlertTitle>ยืนยันไม่สำเร็จ</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={codeId}>รหัสยืนยันหกหลัก</Label>
          <Input
            id={codeId}
            name="one-time-code"
            /*
             * `one-time-code` is what a phone's keyboard reads to offer the code from an SMS
             * or an authenticator — and `inputMode` is separate from it, because a recovery
             * code has letters in it and forcing a numeric keypad would make the fallback
             * untypeable on the device somebody falls back to.
             */
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
          />
          <span className="text-muted-foreground text-xs">
            เปิดแอปยืนยันตัวตนแล้วกรอกตัวเลขหกหลัก — หรือกรอกรหัสสำรองหนึ่งชุดถ้าเข้าแอปไม่ได้
          </span>
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'กำลังยืนยัน…' : 'ยืนยัน'}
        </Button>

        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setChallenge(null);
            setCode('');
            setPassword('');
            setProblem(null);
          }}
        >
          กลับไปกรอกรหัสผ่านใหม่
        </Button>
      </form>
    );
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
        <Label htmlFor={emailId}>อีเมลหรือเบอร์โทร</Label>
        <Input
          id={emailId}
          name="email"
          /*
           * ⚠️ `text`, and it was `email` until a telephone number became a username.
           *
           * `type="email"` makes the *browser* refuse anything without an `@` — before the
           * request is sent, with a message in the browser's own language that has nothing to
           * do with this application. The API had accepted numbers for a commit and nobody
           * could reach it, which is a reminder that a rule stated in four places is a rule
           * changed in three.
           *
           * ⚠️ And no pattern, no client-side "that is not a valid number". The sign-in path
           * is required to be silent about what it recognises — `password.contract.ts`
           * refuses `z.string().email()` for exactly that reason, and a validator here would
           * reinstate the enumeration oracle in the one place an attacker sees it first.
           */
          type="text"
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
