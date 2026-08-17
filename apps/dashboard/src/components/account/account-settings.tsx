'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Monitor, ShieldAlert, Unlink } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { MfaPanel } from './mfa-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
 * ── MFA is here now, and the card that said it was not is gone ───────────────────
 *
 * That card existed for a round and earned its place: a security section silent about MFA
 * reads as "this system has none" *and* as "I must have missed the setting", and only one
 * of those was true. `MfaPanel` replaces it — see plan 6.4 for the design it implements.
 *
 * ── ⭐ Sections, not a stack of cards, and one primary fact ───────────────────
 *
 * This screen was the worst case of the pattern the owner was complaining about: **five Cards
 * of identical weight**, each headed at `text-base` above `text-sm` body copy, and inside the
 * device card **seven more bordered rows** — chrome nested inside chrome, so the page read as
 * boxes all the way down and nothing on it was primary.
 *
 * What is primary here is *how many ways into this account exist*, because that is the fact the
 * whole screen is arranged around: unlink the only provider with no password behind it and
 * there is nothing left. So `waysIn` is now a `type-focal` statement at the top, on the page
 * ground, and the identity that used to be the บัญชี card is folded into it — the card was two
 * lines of text with a ring around them.
 *
 * The other three became `<section>`s with `type-section` headings, and the provider and device
 * rows became `divide-y` lists. **No Card survives on this screen.** Nothing here is
 * self-contained reference; it is all one subject — this account — read top to bottom.
 *
 * ⚠️ The `waysIn <= 1` **Alert** stays an Alert. It is a warning about a consequence rather
 * than a heading, `Alert` is the app's established shape for exactly that, and it is the one
 * element on the page that should look different from its neighbours.
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

  /*
   * The API holds the rule and this screen only reports it — a browser-side copy of "does this
   * still leave a way in" would disagree the day somebody has a password and no verified
   * address, which is precisely the case the rule exists for.
   *
   * ⚠️ `null` at one way in, and that is the point rather than an oversight. The `Alert` above
   * already states that case *with its consequence*, which is the stronger sentence and the one
   * that should be the only one — two elements a centimetre apart both saying
   * "มีทางเข้าสู่ระบบทางเดียว" is the duplication this whole pass is trying to remove. So this
   * caption speaks only when the count is unremarkable, and the Alert speaks when it is not.
   */
  const waysInTh = account.waysIn <= 1 ? null : `มีทางเข้าสู่ระบบ ${account.waysIn} ทาง`;

  return (
    <div className="flex flex-col gap-10">
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

      {/*
       * ⭐ THE PRIMARY THING: who this is, and how many ways in there are.
       *
       * The บัญชี Card that used to hold the name and the addresses was two lines of text with a
       * ring around it. Folded in here, it becomes the identity half of the one statement this
       * screen is about — and the ways-in count, which was previously visible only as a warning
       * when it hit 1, is now always stated.
       */}
      <section className="flex flex-col gap-1">
        <p className="type-focal">{account.displayName ?? '(ไม่มีชื่อ)'}</p>
        {waysInTh === null ? null : (
          <p className="text-muted-foreground type-body">{waysInTh}</p>
        )}
        <div className="type-body mt-2 flex flex-col gap-1">
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
        </div>
      </section>

      <Section
        title="รหัสผ่าน"
        descriptionTh={
          account.hasPassword
            ? 'เมื่อเปลี่ยนแล้ว อุปกรณ์อื่นทั้งหมดจะถูกออกจากระบบ — เครื่องนี้ยังอยู่'
            : 'บัญชีนี้ยังไม่มีรหัสผ่าน ตั้งได้เลยโดยไม่ต้องกรอกรหัสเดิม'
        }
      >
        <div className="flex max-w-md flex-col gap-3">
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
            <p className={tooShort ? 'text-destructive type-body' : 'text-muted-foreground type-body'}>
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
            {mismatch && <p className="text-destructive type-body">สองช่องไม่ตรงกัน</p>}
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
              {busy === 'password' && <Spinner />}
              {account.hasPassword ? 'เปลี่ยนรหัสผ่าน' : 'ตั้งรหัสผ่าน'}
            </Button>
          </div>
        </div>
      </Section>

      <Section title="บัญชีที่เชื่อมไว้" descriptionTh="เข้าสู่ระบบด้วยผู้ให้บริการเหล่านี้ได้">
        {/*
         * ⚠️ `divide-y` and not a border per row. Each provider used to be a `rounded-lg border`
         * *inside* a Card — a box in a box, which is where the ลายตา came from on this screen more
         * than anywhere else. A hairline between rows says "these are separate items" with one
         * edge instead of four, and it is the same statement.
         */}
        <div className="divide-border/60 flex flex-col divide-y">
          {account.providers.length === 0 ? (
            <p className="text-muted-foreground type-body">ยังไม่ได้เชื่อมกับผู้ให้บริการใด</p>
          ) : (
            account.providers.map((provider) => (
              <div
                key={provider.provider}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-col">
                  <span className="type-body">
                    {PROVIDER_LABEL[provider.provider] ?? provider.provider}
                  </span>
                  <span className="text-muted-foreground type-caption">
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
                    <Spinner />
                  ) : (
                    <Unlink className="size-4" />
                  )}
                  ตัดการเชื่อมต่อ
                </Button>
              </div>
            ))
          )}
        </div>
      </Section>

      <Section
        title="อุปกรณ์ที่เข้าสู่ระบบอยู่"
        descriptionTh="เห็นเครื่องที่ไม่รู้จัก ให้กดออกจากระบบแล้วเปลี่ยนรหัสผ่านทันที"
      >
        {/* Seven of these used to be seven bordered boxes inside a bordered box. */}
        <div className="divide-border/60 flex flex-col divide-y">
          {account.sessions.map((session) => (
            <div
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0"
            >
              <div className="flex items-center gap-3">
                <Monitor className="text-muted-foreground size-4" aria-hidden />
                <div className="flex flex-col">
                  <span className="type-body flex items-center gap-2">
                    {deviceName(session.userAgent)}
                    {session.current && <Badge variant="secondary">เครื่องนี้</Badge>}
                  </span>
                  <span className="text-muted-foreground type-caption">
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
                  {busy === session.id && <Spinner />}
                  ออกจากระบบ
                </Button>
              )}
            </div>
          ))}

          {account.sessions.length > 1 && (
            <div className="pt-3">
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
                {busy === 'others' && <Spinner />}
                ออกจากระบบอุปกรณ์อื่นทั้งหมด
              </Button>
            </div>
          )}
        </div>
      </Section>

      <MfaPanel />
    </div>
  );
}

/**
 * One band of the account screen.
 *
 * The three that used to be Cards are these now. A `<section>` with a `type-section` heading and
 * `gap-10` above it: everything on this page is one subject read top to bottom, so there is
 * nothing here that needed separating from its neighbour by a ring.
 *
 * ⚠️ `descriptionTh` is `type-body` rather than the `text-sm` `CardDescription` it replaces —
 * the same size, but named, so the next person applying this to phase 2 does not have to know
 * that `text-sm` happened to be the body step.
 */
function Section({
  title,
  descriptionTh,
  children,
}: {
  readonly title: string;
  readonly descriptionTh: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-section">{title}</h2>
        <p className="text-muted-foreground type-body max-w-2xl">{descriptionTh}</p>
      </div>
      {children}
    </section>
  );
}
