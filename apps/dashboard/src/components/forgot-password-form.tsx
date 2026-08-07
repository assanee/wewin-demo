'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Loader2, MailCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/errors';
import { requestPasswordReset } from '@/lib/auth/password-reset';

/**
 * Asking for a reset link.
 *
 * ── ⭐ The confirmation is the same sentence whatever happened ────────────────────
 *
 * A real address, an address nobody has, an unverified one, a suspended account, a mail
 * server that is down: all of them land here, on this screen, with this wording. The API
 * answers 202 for every one of them and this form must not add a distinction it was careful
 * not to make — "we could not find that address" turns a reset form into the account
 * enumerator that `PasswordSignInService` spends a page of comments avoiding.
 *
 * So the copy says *if* the address belongs to an account. That is slightly worse writing
 * and it is the only honest version.
 *
 * ── The one thing that is reported ───────────────────────────────────────────────
 *
 * 429. The throttle counts the attempt *before* it looks the address up, so a refusal says
 * nothing about whether the account exists — and swallowing it would leave somebody pressing
 * a button that had quietly stopped doing anything.
 */
export function ForgotPasswordForm() {
  const emailId = useId();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? cause.message
          : 'ติดต่อระบบไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่',
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>ส่งลิงก์แล้ว</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <MailCheck className="size-4" />
            <AlertTitle>ตรวจกล่องจดหมายของคุณ</AlertTitle>
            <AlertDescription>
              ถ้า {email} เป็นอีเมลของบัญชีในระบบ เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้แล้ว
              ลิงก์ใช้ได้ครั้งเดียวและหมดอายุใน 60 นาที
            </AlertDescription>
          </Alert>
          <p className="text-muted-foreground text-sm">
            ไม่ได้รับอีเมล? ตรวจโฟลเดอร์สแปมก่อน แล้วจึงขอใหม่ — ขอได้ 3 ครั้งต่อชั่วโมง
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">กลับไปหน้าเข้าสู่ระบบ</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>ลืมรหัสผ่าน</CardTitle>
        <CardDescription>
          กรอกอีเมลของบัญชี แล้วเราจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ไปให้
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
          {problem !== null && (
            <Alert variant="destructive">
              <AlertTitle>ขอลิงก์ไม่สำเร็จ</AlertTitle>
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={emailId}>อีเมล</Label>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </div>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            ส่งลิงก์ตั้งรหัสผ่านใหม่
          </Button>

          <Button asChild variant="ghost" className="w-full">
            <Link href="/login">กลับไปหน้าเข้าสู่ระบบ</Link>
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
