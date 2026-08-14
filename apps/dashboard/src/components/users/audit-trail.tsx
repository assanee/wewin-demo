'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, History } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { failureMessage } from '@/lib/api/errors';
import { listAuditTrail, type AdminEvent, type AdminEventAction } from './user-api';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ WHAT STAFF DID TO ACCOUNTS — because an audit nobody reads is decoration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every one of these actions used to leave a `logger.log` line and nothing else. The record
 * is a table now, and this screen is the other half: the outbox taught the same lesson in
 * this codebase already — *"a dead-lettered notification that nobody sees is worse than
 * none, because the company believes the customer was told."* An audit trail with no reader
 * is the same shape.
 *
 * ── ⚠️ Names are joined at read time, and that is visible here ───────────────
 *
 * The rows store ids. A person renamed last week therefore reads correctly in an entry
 * written last year, and an **erased** person reads as a tombstone with no name — which is
 * what erasure is supposed to look like from here, rather than a gap that reads as data loss.
 */

const ACTION_TH: Record<AdminEventAction, string> = {
  'user.created': 'สร้างบัญชี',
  'user.suspended': 'ระงับบัญชี',
  'user.reinstated': 'ปลดระงับ',
  'user.groups_changed': 'เปลี่ยนกลุ่ม',
  'user.sessions_revoked': 'บังคับออกจากระบบ',
  'user.password_link_sent': 'ส่งลิงก์ตั้งรหัสผ่าน',
  'user.mfa_disabled': 'ปิดการยืนยันสองขั้น',
  'user.phone_verified': 'ยืนยันเบอร์โทร',
  'user.phone_unverified': 'ยกเลิกการยืนยันเบอร์โทร',
  'group.created': 'สร้างกลุ่ม',
  'group.renamed': 'เปลี่ยนชื่อกลุ่ม',
  'group.deleted': 'ลบกลุ่ม',
  'group.permissions_changed': 'เปลี่ยนสิทธิ์ของกลุ่ม',
};

/**
 * The ones that make an account easier to get into.
 *
 * Not a severity scale — every row here is somebody exercising authority. These three are
 * the ones a person scanning the list should stop on, and marking them is the difference
 * between a log and a thing that gets read.
 */
const LOUD: ReadonlySet<AdminEventAction> = new Set<AdminEventAction>([
  'user.mfa_disabled',
  'user.groups_changed',
  'group.permissions_changed',
]);

const at = (iso: string): string =>
  new Date(iso).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly events: readonly AdminEvent[] }
  | { readonly status: 'failed'; readonly problem: string };

export function AuditTrail() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const events = await listAuditTrail();
        if (live) setState({ status: 'ready', events });
      } catch (error) {
        if (live) setState({ status: 'failed', problem: failureMessage(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" />
          บันทึกการจัดการ
        </CardTitle>
        <CardDescription>
          ใครทำอะไรกับบัญชีและสิทธิ์ — บันทึกพร้อมการเปลี่ยนแปลงในทรานแซกชันเดียวกัน แก้และลบไม่ได้
        </CardDescription>
      </CardHeader>

      <CardContent>
        {state.status === 'loading' && <Skeleton className="h-40 w-full" />}

        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>โหลดบันทึกการจัดการไม่สำเร็จ</AlertTitle>
            <AlertDescription>{state.problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && state.events.length === 0 && (
          <p className="text-muted-foreground text-sm">ยังไม่มีการจัดการบัญชีที่บันทึกไว้</p>
        )}

        {state.status === 'ready' && state.events.length > 0 && (
          <ol className="flex flex-col gap-3">
            {state.events.map((event) => (
              <li key={event.seq} className="flex gap-3 text-sm">
                <span className="text-muted-foreground w-12 shrink-0 text-right font-mono text-xs">
                  {event.seq}
                </span>

                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={LOUD.has(event.action) ? 'default' : 'outline'}>
                      {ACTION_TH[event.action] ?? event.action}
                    </Badge>
                    <span>
                      {/*
                       * A tombstone reads as its id, not as a blank. An erased person has no
                       * name by design, and rendering nothing there would look like the row
                       * lost data rather than like the person exercised a right.
                       */}
                      {event.subjectName ??
                        event.subjectGroupCode ??
                        (event.subjectUserId === null
                          ? (event.subjectGroupId?.slice(0, 8) ?? '—')
                          : `${event.subjectUserId.slice(0, 8)} (ลบข้อมูลแล้ว)`)}
                    </span>
                  </span>

                  <span className="text-muted-foreground text-xs">
                    โดย {event.actorName ?? `${event.actorUserId.slice(0, 8)} (ลบข้อมูลแล้ว)`} ·{' '}
                    {at(event.occurredAt)}
                  </span>

                  {Object.keys(event.payload).length > 0 && (
                    <pre className="bg-muted/50 mt-1 max-w-full overflow-x-auto rounded p-2 text-xs">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {state.status === 'ready' && state.events.length >= 100 && (
          <p className="text-muted-foreground mt-3 text-xs">
            {/*
             * ⚠️ Said out loud rather than paged. Beyond a hundred rows the question has
             * stopped being "what happened recently" and become a query somebody should
             * write against the table — a paginator nobody scrolls past page two of would
             * hide that rather than answer it.
             */}
            แสดง 100 รายการล่าสุด — เกินกว่านี้ต้องสอบถามจากฐานข้อมูลโดยตรง
          </p>
        )}
      </CardContent>
    </Card>
  );
}
