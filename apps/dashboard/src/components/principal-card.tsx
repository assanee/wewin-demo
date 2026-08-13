'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/lib/auth/session';

/**
 * `GET /me`, printed.
 *
 * The permission list is rendered as it arrived, without being filtered against this app's
 * copy of the codes. A code the dashboard has never heard of — an API one release ahead —
 * shows up here as itself, which is the difference between "the menu is missing an entry
 * because this build is old" and an unexplained gap.
 */
export function PrincipalCard() {
  const { state } = useSession();

  return (
    <Card>
      <CardHeader>
        {/* Keeps its Card: a collapsed diagnostic dump *is* self-contained reference. */}
        <CardTitle className="type-section">บัญชีที่กำลังใช้งาน</CardTitle>
        <CardDescription>ข้อมูลนี้มาจาก /me ของ API โดยตรง เมนูด้านซ้ายคำนวณจากรายการสิทธิ์ด้านล่าง</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {state.status !== 'signed-in' ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground text-sm">รหัสผู้ใช้</dt>
              <dd className="font-mono text-sm break-all">{state.principal.userId ?? '—'}</dd>

              <dt className="text-muted-foreground text-sm">กลุ่ม</dt>
              <dd className="text-sm">
                {state.principal.groupIds.length === 0 ? (
                  <span className="text-muted-foreground">ไม่ได้อยู่ในกลุ่มใด</span>
                ) : (
                  <span className="font-mono break-all">{state.principal.groupIds.join(', ')}</span>
                )}
              </dd>
            </dl>

            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-sm">
                สิทธิ์ ({String(state.principal.permissions.length)})
              </span>
              {state.principal.permissions.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  บัญชีนี้ยังไม่มีสิทธิ์ใด — ผู้ดูแลระบบต้องเพิ่มบัญชีเข้ากลุ่มก่อน
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {state.principal.permissions.map((code) => (
                    <Badge key={code} variant="secondary" className="font-mono">
                      {code}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
