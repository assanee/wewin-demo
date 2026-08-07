'use client';

import { useCallback, useState } from 'react';
import { Copy, Check, Link2, AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { failureMessage } from '@/lib/api/errors';
import { getCustomerLink } from './quote-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The quotation link, for a member of staff to send by hand.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The outbox can only reach an email address. A customer who gave a telephone number and
 * nothing else receives every message as `suppressed / no_contact_channel` — so this is the
 * manual channel: copy, paste into LINE, done.
 *
 * ── ⚠️ Fetched on demand, never on render ────────────────────────────────────
 *
 * Every call mints a **fresh bearer credential** valid for six months. Loading one when the
 * page opens would put a live link in the browser's memory, in the network log and in
 * anything recording the session, for every quotation a member of staff merely looked at.
 * A button means the credential exists because somebody meant to send it.
 */
export function CustomerLinkBar({ orderId }: { readonly orderId: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchAndCopy = useCallback(async () => {
    setBusy(true);
    setProblem(null);

    try {
      const { url } = await getCustomerLink(orderId);
      setLink(url);

      /*
       * ⚠️ Best-effort. `navigator.clipboard` needs a secure context and a permission, and
       * neither is guaranteed — so the URL is *shown* as well as copied, and a failed copy
       * leaves a link somebody can select by hand rather than an error about a clipboard.
       */
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 2_000);
      } catch {
        setCopied(false);
      }
    } catch (error) {
      setProblem(failureMessage(error));
    } finally {
      setBusy(false);
    }
  }, [orderId]);

  return (
    <div className="flex flex-col gap-2 print:hidden">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void fetchAndCopy()} disabled={busy}>
          {copied ? <Check /> : <Link2 />}
          {copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์สำหรับลูกค้า'}
        </Button>
        <span className="text-muted-foreground text-xs">
          ลิงก์เปิดใบเสนอราคาฉบับนี้ได้โดยไม่ต้องเข้าสู่ระบบ · ใช้ได้ 6 เดือน
        </span>
      </div>

      {link === null ? null : (
        <div className="flex items-center gap-2">
          {/*
            ⚠️ Shown as selectable text, not only copied. See the comment on the copy above:
            a clipboard that refuses must not leave the person with nothing.
          */}
          <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs">
            {link}
          </code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(
                () => {
                  setCopied(true);
                },
                () => undefined,
              );
            }}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      )}

      {problem === null ? null : (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>สร้างลิงก์ไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
