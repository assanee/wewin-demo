'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Monitor, ShieldAlert, Unlink } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/components/products/catalog-api';
import { PASSWORD_MIN_LENGTH, passwordLength } from '@/lib/auth/password-reset';
import {
  changeMyPassword,
  getAccount,
  revokeMyOtherSessions,
  revokeMySession,
  unlinkProvider,
  type Account,
} from '@/lib/auth/account-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Your own account.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The one screen where somebody can remove their *own* way of signing in, which is the
 * failure this page is arranged around: unlink the only Google account with no password
 * behind it and there is nothing left — no credential to present, and no reset link to
 * request, because a reset link only reaches a verified address.
 *
 * The API refuses that (`credentials.ts`) and this screen shows the count rather than
 * recomputing the rule. A browser-side copy of "does this still leave a way in" would
 * disagree the day somebody has a password and no verified address, which is precisely the
 * case the rule exists for.
 *
 * ── MFA is not here, and the page says so ────────────────────────────────────────
 *
 * Nothing in the schema stores a TOTP secret, a recovery code or a second-factor state —
 * `grep` returns zero rows. Rather than leave a gap the reader has to notice, the security
 * section names it as not built, because a settings page silently missing a security control
 * reads as "this system has no MFA" *and* as "I must have missed it", and only one of those
 * is true.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly account: Account };

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
  line: 'LINE',
};

/** A user agent as a person recognises it. Coarse on purpose — this is not analytics. */
function deviceName(userAgent: string | null): string {
  if (userAgent === null || userAgent.trim() === '') return 'อุปกรณ์ที่ไม่ทราบชนิด';
  const os = /Windows/i.test(userAgent)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(userAgent)
      ? 'Mac'
      : /Android/i.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/i.test(userAgent)
          ? 'iOS'
          : 'ระบบอื่น';
  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /Chrome\//i.test(userAgent)
      ? 'Chrome'
      : /Safari\//i.test(userAgent)
        ? 'Safari'
        : /Firefox\//i.test(userAgent)
          ? 'Firefox'
          : 'เบราว์เซอร์อื่น';

  return `${browser} บน ${os}`;
}

const when = (iso: string | null): string =>
  iso === null ? '—' : new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

export function AccountSettings() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  async function reload(): Promise<void> {
    try {
      setState({ status: 'ready', account: await getAccount() });
    } catch (cause) {
      setState({ status: 'failed', message: failureMessage(cause) });
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function act(key: string, run: () => Promise<unknown>, said: string): Promise<void> {
    setBusy(key);
    setProblem(null);
    setNote(null);
    try {
      await run();
      setNote(said);
      await reload();
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (state.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (state.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>โหลดข้อมูลบัญชีไม่สำเร็จ</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }

  const { account } = state;
  const tooShort = next !== '' && passwordLength(next) < PASSWORD_MIN_LENGTH;
  const mismatch = confirm !== '' && confirm !== next;
  const canSubmit =
    next !== '' &&
    !tooShort &&
    confirm === next &&
    (!account.hasPassword || current !== '');

  return (
    <div className="flex flex-col gap-4">
      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {note !== null && (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}

      {/*
        ⚠️ Shown whenever there is exactly one, not only when an action is refused. Somebody
        about to unlink their last provider should learn that from the page they are already
        looking at, not from a 409 after pressing the button.
      */}
      {account.waysIn <= 1 && (
        <Alert>
          <ShieldAlert className="size-4" />
          <AlertTitle>ตอนนี้มีทางเข้าสู่ระบบทางเดียว</AlertTitle>
          <AlertDescription>
            ถ้าเสียทางนี้ไปจะเข้าระบบไม่ได้เลย และต้องให้ผู้ดูแลช่วย — ตั้งรหัสผ่านหรือเชื่อมผู้ให้บริการเพิ่มอีกทางจะปลอดภัยกว่า
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>บัญชี</CardTitle>
          <CardDescription>{account.displayName ?? '(ไม่มีชื่อ)'}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {account.emails.length === 0 ? (
            <p className="text-muted-foreground">
              ยังไม่มีอีเมลที่ยืนยันแล้ว — ลิงก์ตั้งรหัสผ่านใหม่จะส่งไปไม่ได้
            </p>
          ) : (
            account.emails.map((email) => (
              <span key={email.address} className="flex items-center gap-2">
                {email.address}
                {email.isPrimary && <Badge variant="outline">หลัก</Badge>}
              </span>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>รหัสผ่าน</CardTitle>
          <CardDescription>
            {account.hasPassword
              ? 'เมื่อเปลี่ยนแล้ว อุปกรณ์อื่นทั้งหมดจะถูกออกจากระบบ — เครื่องนี้ยังอยู่'
              : 'บัญชีนี้ยังไม่มีรหัสผ่าน ตั้งได้เลยโดยไม่ต้องกรอกรหัสเดิม'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex max-w-md flex-col gap-3">
          {account.hasPassword && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="current-password">รหัสผ่านปัจจุบัน</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                disabled={busy === 'password'}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="next-password">รหัสผ่านใหม่</Label>
            <Input
              id="next-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              disabled={busy === 'password'}
              aria-invalid={tooShort}
            />
            <p className={tooShort ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
              อย่างน้อย {PASSWORD_MIN_LENGTH} ตัวอักษร
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-password">พิมพ์อีกครั้ง</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={busy === 'password'}
              aria-invalid={mismatch}
            />
            {mismatch && <p className="text-destructive text-sm">สองช่องไม่ตรงกัน</p>}
          </div>

          <div>
            <Button
              disabled={busy === 'password' || !canSubmit}
              onClick={() =>
                void act(
                  'password',
                  async () => {
                    const result = await changeMyPassword({
                      ...(account.hasPassword ? { currentPassword: current } : {}),
                      newPassword: next,
                    });
                    setCurrent('');
                    setNext('');
                    setConfirm('');
                    return result;
                  },
                  'เปลี่ยนรหัสผ่านแล้ว และออกจากระบบอุปกรณ์อื่นทั้งหมด',
                )
              }
            >
              {busy === 'password' && <Loader2 className="size-4 animate-spin" />}
              {account.hasPassword ? 'เปลี่ยนรหัสผ่าน' : 'ตั้งรหัสผ่าน'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>บัญชีที่เชื่อมไว้</CardTitle>
          <CardDescription>เข้าสู่ระบบด้วยผู้ให้บริการเหล่านี้ได้</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {account.providers.length === 0 ? (
            <p className="text-muted-foreground text-sm">ยังไม่ได้เชื่อมกับผู้ให้บริการใด</p>
          ) : (
            account.providers.map((provider) => (
              <div
                key={provider.provider}
                className="border-border/60 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex flex-col">
                  <span>{PROVIDER_LABEL[provider.provider] ?? provider.provider}</span>
                  <span className="text-muted-foreground text-xs">
                    {provider.assertedEmail ?? 'ไม่ทราบอีเมล'} · ใช้ล่าสุด{' '}
                    {when(provider.lastAuthenticatedAt)}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === provider.provider}
                  onClick={() =>
                    void act(
                      provider.provider,
                      () => unlinkProvider(provider.provider),
                      `ตัดการเชื่อมต่อกับ ${PROVIDER_LABEL[provider.provider] ?? provider.provider} แล้ว`,
                    )
                  }
                >
                  {busy === provider.provider ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Unlink className="size-4" />
                  )}
                  ตัดการเชื่อมต่อ
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>อุปกรณ์ที่เข้าสู่ระบบอยู่</CardTitle>
          <CardDescription>
            เห็นเครื่องที่ไม่รู้จัก ให้กดออกจากระบบแล้วเปลี่ยนรหัสผ่านทันที
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {account.sessions.map((session) => (
            <div
              key={session.id}
              className="border-border/60 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="flex items-center gap-3">
                <Monitor className="text-muted-foreground size-4" />
                <div className="flex flex-col">
                  <span className="flex items-center gap-2">
                    {deviceName(session.userAgent)}
                    {session.current && <Badge variant="secondary">เครื่องนี้</Badge>}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    เข้าใช้ล่าสุด {when(session.lastSeenAt ?? session.createdAt)}
                  </span>
                </div>
              </div>

              {!session.current && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === session.id}
                  onClick={() =>
                    void act(session.id, () => revokeMySession(session.id), 'ออกจากระบบอุปกรณ์นั้นแล้ว')
                  }
                >
                  {busy === session.id && <Loader2 className="size-4 animate-spin" />}
                  ออกจากระบบ
                </Button>
              )}
            </div>
          ))}

          {account.sessions.length > 1 && (
            <div>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy === 'others'}
                onClick={() =>
                  void act(
                    'others',
                    () => revokeMyOtherSessions(),
                    'ออกจากระบบอุปกรณ์อื่นทั้งหมดแล้ว',
                  )
                }
              >
                {busy === 'others' && <Loader2 className="size-4 animate-spin" />}
                ออกจากระบบอุปกรณ์อื่นทั้งหมด
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>การยืนยันตัวตนสองขั้น (MFA)</CardTitle>
        </CardHeader>
        <CardContent>
          {/*
            Named as not built rather than left out. A security section with no mention of
            MFA reads two ways at once — "this system has no MFA" and "I must have missed
            the setting" — and only one of them is true.
          */}
          <Alert>
            <AlertTitle>ยังไม่ได้พัฒนา</AlertTitle>
            <AlertDescription>
              ระบบยังไม่รองรับการยืนยันสองขั้น — ยังไม่มีที่เก็บ secret และยังไม่มีขั้นที่สองในการเข้าสู่ระบบ
              · แผนที่ตกลงไว้คือ TOTP พร้อมรหัสสำรอง และให้ผู้ดูแลปิดให้ได้เมื่อทำอุปกรณ์หาย (ดูแผนข้อ 6.4)
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
