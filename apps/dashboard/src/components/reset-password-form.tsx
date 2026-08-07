'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/errors';
import {
  PASSWORD_MIN_LENGTH,
  completePasswordReset,
  passwordLength,
} from '@/lib/auth/password-reset';

/**
 * Setting a new password from a link in an email.
 *
 * ── ⚠️ This page exists because the link had nowhere to land ─────────────────────
 *
 * `PASSWORD_RESET_URL_BASE` was pointed at `/reset-password` when the reset endpoints were
 * built, and the page was never written. Every message the API sent carried a working
 * one-shot token to a 404. The API half was proven end to end with `curl`, which is exactly
 * why it was not noticed: a verified endpoint is not a usable feature.
 *
 * ── The confirmation field is not a formality ────────────────────────────────────
 *
 * The token is one-shot. Somebody who mistypes their new password does not get a second
 * chance at the link — they have set a password they cannot reproduce, and their next move
 * is to ask for another email. Two fields, compared before the request leaves.
 *
 * ── No session is issued, and that is the API's decision ─────────────────────────
 *
 * `POST /auth/password/reset` answers 204 and signs nobody in. Making a mailbox a credential
 * is the thing it declines to do, so this page ends by sending the person to `/login` to
 * type the new password once — which is also the moment they find out it works.
 *
 * ── The rule is checked here and *decided* by the API ────────────────────────────
 *
 * The minimum is restated in `password-reset.ts` because `turbo boundaries` will not let the
 * dashboard import from apps/api. Only the button's disabled state uses it; the refusal
 * shown on a real failure is the API's own sentence, so a drift between the two costs a
 * round trip rather than a wrong instruction.
 */
export function ResetPasswordForm() {
  const search = useSearchParams();
  const token = search.get('token');

  const passwordId = useId();
  const confirmId = useId();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const tooShort = password !== '' && passwordLength(password) < PASSWORD_MIN_LENGTH;
  const mismatch = confirm !== '' && confirm !== password;
  const ready = password !== '' && !tooShort && confirm === password;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (token === null) return;

    setBusy(true);
    setProblem(null);
    try {
      await completePasswordReset(token, password);
      setDone(true);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? cause.message
          : 'ติดต่อระบบไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่',
      );
      setBusy(false);
    }
  }

  /*
   * A link with no `?token=` at all. Answered here rather than by letting the form submit
   * and translating the API's refusal, because this one *is* safe to be specific about: it
   * says nothing about any account, only that the URL is incomplete — most likely an email
   * client that wrapped the line.
   */
  if (token === null) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>ลิงก์ไม่สมบูรณ์</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertTitle>ไม่พบรหัสยืนยันในลิงก์</AlertTitle>
            <AlertDescription>
              ลิงก์อาจถูกตัดตอนคัดลอกมาจากอีเมล ลองกดจากในอีเมลโดยตรง หรือขอลิงก์ใหม่
            </AlertDescription>
          </Alert>
          <Button asChild className="w-full">
            <Link href="/forgot-password">ขอลิงก์ใหม่</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>ตั้งรหัสผ่านใหม่แล้ว</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <CheckCircle2 className="size-4" />
            <AlertTitle>เรียบร้อย</AlertTitle>
            <AlertDescription>
              {/* Said out loud because it is a surprise otherwise: the person's phone and
                  their other laptop have both been signed out, and that is the point of a
                  reset rather than a side effect of it. */}
              ระบบออกจากระบบทุกอุปกรณ์ของบัญชีนี้แล้วเพื่อความปลอดภัย
              กรุณาเข้าสู่ระบบใหม่ด้วยรหัสผ่านที่เพิ่งตั้ง
            </AlertDescription>
          </Alert>
          <Button asChild className="w-full">
            <Link href="/login">ไปหน้าเข้าสู่ระบบ</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>ตั้งรหัสผ่านใหม่</CardTitle>
        <CardDescription>
          ลิงก์นี้ใช้ได้ครั้งเดียว — เมื่อตั้งเสร็จ ระบบจะออกจากระบบทุกอุปกรณ์
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTitle>ตั้งรหัสผ่านไม่สำเร็จ</AlertTitle>
              <AlertDescription>
                {problem}
                {/* A spent or expired link cannot be retried, so the way out is offered
                    beside the refusal rather than left for the person to find. */}
                <span className="mt-2 block">
                  <Link href="/forgot-password" className="underline">
                    ขอลิงก์ใหม่
                  </Link>
                </span>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={passwordId}>รหัสผ่านใหม่</Label>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              aria-invalid={tooShort}
            />
            <p className={tooShort ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
              อย่างน้อย {PASSWORD_MIN_LENGTH} ตัวอักษร — ประโยคที่จำได้ดีกว่าคำสั้นๆ ที่ซับซ้อน
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={confirmId}>พิมพ์รหัสผ่านใหม่อีกครั้ง</Label>
            <Input
              id={confirmId}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={busy}
              aria-invalid={mismatch}
            />
            {mismatch && <p className="text-destructive text-sm">รหัสผ่านสองช่องไม่ตรงกัน</p>}
          </div>

          <Button type="submit" className="w-full" disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            ตั้งรหัสผ่านใหม่
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
