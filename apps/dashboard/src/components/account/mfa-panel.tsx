'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import qrcode from 'qrcode-generator';

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
 * ── ⭐ Scan, prove, then the codes — in that order ───────────────────────────
 *
 * The first version showed the recovery codes first, before anything had been proved. They
 * were an obstacle between somebody and the thing they came to do, which is the position
 * nothing gets read in. They arrive at the moment of success now — and only to a person who
 * has just demonstrated they hold the authenticator, so somebody who starts an enrolment and
 * walks away receives none at all.
 *
 * Only fingerprints are stored, so nothing on the server can produce them again — "show me
 * again" is not a feature left out, it is a thing the storage makes impossible. The panel
 * refuses to move past them until the person has ticked that they are saved.
 *
 * ⚠️ Closing the tab there is survivable and was worth checking: the gate is up, but the
 * person holds a working authenticator, so they sign in and regenerate. It is a bad
 * afternoon, not a lockout.
 *
 * ── ⚠️ Two actions ask for the password, and one of them looks like it should not ──
 *
 * Disabling, obviously. And **regenerating**, which adds nothing and removes nothing — but
 * kills the old set and puts a new one on screen for whoever asked, which is ten permanent
 * entries into an account somebody borrowed for a minute. The API's `reproof.ts` argues it;
 * the form asks for it because the API will.
 */

/**
 * ⭐ Scan, prove, *then* the codes.
 *
 * The first version showed the recovery codes before anything had been proved — an obstacle
 * between somebody and the thing they came to do, read by nobody. They arrive at the moment
 * of success now, which is when attention exists, and only to a person who has just
 * demonstrated they hold the authenticator.
 */
type Step =
  | { readonly kind: 'idle' }
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
      <section className="flex flex-col gap-4">
        <h2 className="type-section">การยืนยันตัวตนสองขั้น (MFA)</h2>
        <Skeleton className="h-20 w-full" />
      </section>
    );
  }

  return (
    /*
     * A `<section>` and not a `Card` — the last one on this screen to go. It was tempting to
     * keep it: MFA enrolment is genuinely self-contained, with a QR code and a set of recovery
     * codes inside it. But it would then have been the *only* bordered thing on `/account`,
     * which reads as "this one is special" rather than as "this one is separable", and the four
     * bands of this page are peers in one subject. It still has the loudest control on the
     * screen; a ring is not what was giving it that.
     */
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-section flex items-center gap-2">
          <ShieldCheck className="size-5" aria-hidden />
          การยืนยันตัวตนสองขั้น (MFA)
        </h2>
        <p className="text-muted-foreground type-body max-w-2xl">
          {state.enabled
            ? 'เปิดอยู่ — ตอนเข้าสู่ระบบจะถามรหัสหกหลักจากแอปยืนยันตัวตนเพิ่มอีกขั้น'
            : 'ยังไม่ได้เปิด — เปิดแล้วรหัสผ่านอย่างเดียวจะเข้าบัญชีนี้ไม่ได้อีก'}
        </p>
      </div>

      <div className="flex flex-col gap-4">
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

        {/* ── The codes, shown once — after the gate is up ───────────────── */}
        {step.kind === 'fresh-codes' && (
          <RecoveryCodes
            codes={step.codes}
            onDone={() => {
              setStep({ kind: 'idle' });
              void reload();
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
             * ⭐ A real QR, drawn here.
             *
             * ⚠️ An earlier version of this comment said a QR "needs a library, and this app
             * inlines everything under a strict CSP". Both halves were wrong: the dashboard
             * sets no CSP at all, and a bundled encoder would satisfy one anyway since it
             * fetches nothing. It was a constraint invented to justify not doing the work,
             * while the text above the box went on promising a QR that was not there.
             *
             * `qrcode-generator` is 2.0.4, zero dependencies, and emits an inline SVG — no
             * canvas, no image request, no data the browser has to go and get.
             */}
            <QrCode uri={step.enrolment.otpauthUri} />

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
                    const codes = await confirmEnrolment(code);
                    toast.success('เปิดการยืนยันสองขั้นแล้ว');
                    setCode('');
                    /* Straight to the codes — the gate is up and this is their only showing. */
                    setStep({ kind: 'fresh-codes', codes });
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
                    setStep({ kind: 'confirming', enrolment: await beginEnrolment() });
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
      </div>
    </section>
  );
}

/**
 * The `otpauth://` URI, as something a camera can read.
 *
 * ⚠️ Rendered as an **inline SVG string**, not a canvas and not an image URL. A canvas would
 * need a ref and an effect to draw into, and would come out blank in any screenshot taken
 * before it painted; an image URL would be a request. This is markup the browser already
 * has, which also means it survives the print stylesheet and a dark theme without asking.
 *
 * `typeNumber: 0` lets the encoder pick the smallest version that fits — an `otpauth` URI
 * with a 32-character secret is comfortably inside a small one, and pinning a version would
 * either waste space or break the day the issuer string grows.
 *
 * Error correction `M`: the middle setting, and the right one for something displayed on a
 * screen rather than printed on a box that gets scuffed.
 */
function QrCode({ uri }: { readonly uri: string }) {
  const code = qrcode(0, 'M');
  code.addData(uri);
  code.make();

  return (
    <div
      className="w-fit rounded-lg bg-white p-3"
      aria-label="QR สำหรับตั้งค่าแอปยืนยันตัวตน"
      /*
       * The SVG comes from an encoder in this bundle, over a URI this application built from
       * a secret it generated a moment ago. No part of it is user input, which is what makes
       * `dangerouslySetInnerHTML` the right tool rather than a shortcut here.
       *
       * `bg-white` and not the theme's surface: a QR inverted by dark mode does not scan.
       */
      dangerouslySetInnerHTML={{
        __html: code.createSvgTag({ cellSize: 5, margin: 0, scalable: false }),
      }}
    />
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
  onDone,
}: {
  readonly codes: readonly string[];
  readonly onDone: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

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
          <Button type="button" variant="outline" onClick={() => setAcknowledged(true)}>
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
