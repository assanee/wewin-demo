'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/lib/api/errors';
import {
  beginEnrolment,
  confirmEnrolment,
  disableMfa,
  getMfaState,
  regenerateRecoveryCodes,
  type Enrolment,
  type MfaState,
} from './mfa-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The second factor, from a person's own account.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This card replaces the one that said MFA did not exist yet.
 *
 * ── ⭐ The codes are shown once, and the screen says so before showing them ──
 *
 * Only fingerprints are stored, so nothing on the server can produce them again — "show me
 * again" is not a feature left out, it is a thing the storage makes impossible. The panel
 * therefore refuses to move past them until the person has ticked that they are saved. That
 * checkbox is not ceremony: the failure it prevents is somebody closing a tab at the exact
 * moment their recovery path becomes unrecoverable.
 *
 * ── ⚠️ Two actions ask for the password, and one of them looks like it should not ──
 *
 * Disabling, obviously. And **regenerating**, which adds nothing and removes nothing — but
 * kills the old set and puts a new one on screen for whoever asked, which is ten permanent
 * entries into an account somebody borrowed for a minute. The API's `reproof.ts` argues it;
 * the form asks for it because the API will.
 */

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'showing'; readonly enrolment: Enrolment; readonly saved: boolean }
  | { readonly kind: 'confirming'; readonly enrolment: Enrolment }
  | { readonly kind: 'disabling' }
  | { readonly kind: 'regenerating' }
  | { readonly kind: 'fresh-codes'; readonly codes: readonly string[] };

export function MfaPanel() {
  const [state, setState] = useState<MfaState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    try {
      setState(await getMfaState());
    } catch (error) {
      setProblem(failureMessage(error));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setProblem(null);
    void (async () => {
      try {
        await work();
      } catch (error) {
        setProblem(failureMessage(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (state === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>การยืนยันตัวตนสองขั้น (MFA)</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" />
          การยืนยันตัวตนสองขั้น (MFA)
        </CardTitle>
        <CardDescription>
          {state.enabled
            ? 'เปิดอยู่ — ตอนเข้าสู่ระบบจะถามรหัสหกหลักจากแอปยืนยันตัวตนเพิ่มอีกขั้น'
            : 'ยังไม่ได้เปิด — เปิดแล้วรหัสผ่านอย่างเดียวจะเข้าบัญชีนี้ไม่ได้อีก'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {problem !== null && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        {/*
         * ⚠️ The warning that matters most, and it fires before the last code is gone.
         * Somebody at zero still has MFA on and no way through it — the only route back is
         * an administrator, which is a telephone call rather than a screen.
         */}
        {state.enabled && state.recoveryCodesLow && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>
              {state.recoveryCodesRemaining === 0
                ? 'ไม่เหลือรหัสสำรองแล้ว'
                : `เหลือรหัสสำรองอีก ${String(state.recoveryCodesRemaining)} ชุด`}
            </AlertTitle>
            <AlertDescription>
              {state.recoveryCodesRemaining === 0
                ? 'ถ้าทำมือถือหายตอนนี้จะเข้าบัญชีไม่ได้เลย ต้องให้ผู้ดูแลระบบปิด MFA ให้ — ออกรหัสสำรองชุดใหม่ทันที'
                : 'ออกชุดใหม่ไว้ก่อนหมด'}
            </AlertDescription>
          </Alert>
        )}

        {/* ── The codes, shown once ─────────────────────────────────────── */}
        {(step.kind === 'showing' || step.kind === 'fresh-codes') && (
          <RecoveryCodes
            codes={step.kind === 'showing' ? step.enrolment.recoveryCodes : step.codes}
            acknowledged={step.kind === 'showing' ? step.saved : true}
            onAcknowledge={() => {
              if (step.kind === 'showing') setStep({ ...step, saved: true });
            }}
            onDone={() => {
              if (step.kind === 'showing') setStep({ kind: 'confirming', enrolment: step.enrolment });
              else {
                setStep({ kind: 'idle' });
                void reload();
              }
            }}
          />
        )}

        {/* ── Scan, then prove it arrived ───────────────────────────────── */}
        {step.kind === 'confirming' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              สแกน QR หรือกรอกรหัสลับนี้ในแอปยืนยันตัวตน แล้วกรอกตัวเลขหกหลักที่แอปแสดงเพื่อยืนยัน
            </p>

            {/*
             * The URI as text rather than a rendered QR code. Drawing one needs a library,
             * and this app inlines everything under a strict CSP — so the honest thing today
             * is the secret in a form somebody can type, plus the link an authenticator on
             * the same device can open. A QR renderer is worth adding and is not worth
             * pretending to have.
             */}
            <div className="flex flex-col gap-1.5">
              <Label>รหัสลับ</Label>
              <div className="flex gap-2">
                <Input readOnly value={step.enrolment.secretBase32} className="font-mono" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(step.enrolment.secretBase32);
                    toast.success('คัดลอกแล้ว');
                  }}
                >
                  <Copy />
                </Button>
              </div>
              <a
                href={step.enrolment.otpauthUri}
                className="text-muted-foreground hover:text-foreground text-xs underline"
              >
                เปิดในแอปยืนยันตัวตนบนเครื่องนี้
              </a>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mfa-confirm">รหัสหกหลักจากแอป</Label>
              <Input
                id="mfa-confirm"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <Button
                disabled={busy || code.trim() === ''}
                onClick={() =>
                  run(async () => {
                    await confirmEnrolment(code);
                    toast.success('เปิดการยืนยันสองขั้นแล้ว');
                    setCode('');
                    setStep({ kind: 'idle' });
                    await reload();
                  })
                }
              >
                ยืนยันและเปิดใช้งาน
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setStep({ kind: 'idle' })}>
                ยกเลิก
              </Button>
            </div>
          </div>
        )}

        {/* ── The password-costing actions ──────────────────────────────── */}
        {(step.kind === 'disabling' || step.kind === 'regenerating') && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mfa-password">รหัสผ่านของคุณ</Label>
              <Input
                id="mfa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <span className="text-muted-foreground text-xs">
                {step.kind === 'disabling'
                  ? 'ถามซ้ำเพราะการปิดทำให้บัญชีปลอดภัยน้อยลง'
                  : 'ถามซ้ำเพราะรหัสสำรองชุดเดิมจะใช้ไม่ได้ทันที และชุดใหม่จะขึ้นบนหน้าจอนี้'}
              </span>
            </div>

            <div className="flex gap-2">
              <Button
                variant={step.kind === 'disabling' ? 'destructive' : 'default'}
                disabled={busy || password === ''}
                onClick={() =>
                  run(async () => {
                    if (step.kind === 'disabling') {
                      await disableMfa(password);
                      toast.success('ปิดการยืนยันสองขั้นแล้ว');
                      setStep({ kind: 'idle' });
                      await reload();
                    } else {
                      const codes = await regenerateRecoveryCodes(password);
                      setStep({ kind: 'fresh-codes', codes });
                    }
                    setPassword('');
                  })
                }
              >
                {step.kind === 'disabling' ? 'ปิดการยืนยันสองขั้น' : 'ออกรหัสสำรองชุดใหม่'}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPassword('');
                  setStep({ kind: 'idle' });
                }}
              >
                ยกเลิก
              </Button>
            </div>
          </div>
        )}

        {/* ── The buttons ───────────────────────────────────────────────── */}
        {step.kind === 'idle' && (
          <div className="flex flex-wrap gap-2">
            {!state.enabled && (
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setStep({ kind: 'showing', enrolment: await beginEnrolment(), saved: false });
                  })
                }
              >
                {state.enrolling ? 'เริ่มตั้งค่าใหม่' : 'เปิดการยืนยันสองขั้น'}
              </Button>
            )}

            {state.enabled && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setStep({ kind: 'regenerating' })}>
                  ออกรหัสสำรองชุดใหม่
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => setStep({ kind: 'disabling' })}>
                  ปิดการยืนยันสองขั้น
                </Button>
              </>
            )}
          </div>
        )}

        {state.enabled && step.kind === 'idle' && (
          <p className="text-muted-foreground text-xs">
            เหลือรหัสสำรอง {state.recoveryCodesRemaining} ชุด
            {state.confirmedAt === null
              ? ''
              : ` · เปิดใช้เมื่อ ${new Date(state.confirmedAt).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' })}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * ⭐ The one screen these ever appear on.
 *
 * The acknowledgement is not ceremony. Only fingerprints are stored, so the moment this
 * component unmounts the codes are gone from every computer involved — and the person most
 * likely to close the tab early is the one who has not understood that yet.
 */
function RecoveryCodes({
  codes,
  acknowledged,
  onAcknowledge,
  onDone,
}: {
  readonly codes: readonly string[];
  readonly acknowledged: boolean;
  readonly onAcknowledge: () => void;
  readonly onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Alert>
        <AlertTriangle />
        <AlertTitle>เก็บรหัสสำรองนี้ไว้ก่อนไปต่อ</AlertTitle>
        <AlertDescription>
          หน้านี้คือที่เดียวที่รหัสเหล่านี้จะปรากฏ — ระบบเก็บไว้เป็นค่าแฮชเท่านั้น เปิดดูซ้ำไม่ได้
          ใช้ได้ชุดละครั้งเมื่อเข้าแอปยืนยันตัวตนไม่ได้
        </AlertDescription>
      </Alert>

      <ol className="bg-muted/40 grid grid-cols-2 gap-2 rounded-lg p-4 font-mono text-sm">
        {codes.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(codes.join('\n'));
            toast.success('คัดลอกรหัสสำรองแล้ว');
          }}
        >
          <Copy /> คัดลอกทั้งหมด
        </Button>

        {!acknowledged && (
          <Button type="button" variant="outline" onClick={onAcknowledge}>
            <Check /> เก็บไว้เรียบร้อยแล้ว
          </Button>
        )}

        <Button type="button" disabled={!acknowledged} onClick={onDone}>
          ไปต่อ
        </Button>
      </div>
    </div>
  );
}
