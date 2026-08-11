'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, LogOut, Phone, PhoneOff, Plus, ShieldOff, UserCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { failureMessage } from '@/components/products/catalog-api';
import { useSession } from '@/lib/auth/session';

import {
  listGroups,
  listUsers,
  reinstateUser,
  disableUserMfa,
  revokeSessions,
  sendPasswordLink,
  unverifyPhone,
  verifyPhone,
  type Group,
  type UserPhone,
  type UserSummary,
} from './user-api';
import { listAuthorityLimits } from './authority-limits-api';
import AuthorityLimitsPanel, { type AuthorityLimitsState } from './authority-limits-panel';
import { CreateUserDialog } from './create-user-dialog';
import { GroupsPanel } from './groups-panel';
import { AuditTrail } from './audit-trail';
import { SuspendDialog } from './suspend-dialog';
import { UserGroupsDialog } from './user-groups-dialog';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Who works here, and the three ways to take access away.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * They are three because they answer different sentences, and collapsing them into one
 * button would answer the wrong one most of the time:
 *
 *   **ออกจากระบบทุกอุปกรณ์** — "my phone was stolen on the way home". Ends every session and
 *   leaves the person able to work in the morning.
 *
 *   **ระงับบัญชี** — "this person no longer works here". Reversible, and the database ends
 *   their sessions in the same transaction (`users_status_revoke_sessions`).
 *
 *   **แก้กลุ่ม** — "they moved to another team". Changes what they may do without stopping
 *   them doing the rest.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────────
 *
 * No delete, and no "close account". Erasure is `erase_user()` in Postgres, it is
 * irreversible, and plan 7.16 still holds questions a lawyer owns — a button would settle
 * them by shipping. `closed` is worse than useless here: nothing in the dashboard can undo
 * it, so an administrator pressing it on a password-only colleague creates a state only a
 * database prompt can leave.
 *
 * ── The screen never decides whether an action is allowed ────────────────────────
 *
 * The lockout guards live in `apps/api/src/users/lockout.ts` and answer 409. This screen
 * shows the refusal and does not attempt to predict it — a client-side copy of "is this the
 * last administrator" would be a second implementation of the only rule here that cannot be
 * recovered from, and the two would disagree the day somebody is in two admin groups.
 *
 * ── ⭐ Phone verification, and why it is a badge next to a claim rather than a fact ──────
 *
 * `user_phones` has no dedicated screen and this list is where staff already look at any
 * account, customer or colleague — so the verify/un-verify control lives here rather than
 * on an invented "customer detail" page nothing else in the dashboard has.
 *
 * ⚠️ It is not proof of possession. The owner's decision was no SMS OTP — no provider, no
 * per-message cost — so this button records that *a member of staff, having spoken to the
 * customer, vouches for the number*. That is a real and weaker claim than an OTP would be,
 * and `PhoneList` below shows every claim (unlike `emails`, which shows only proven ones)
 * precisely so an unverified one is visible to act on rather than hidden and mistaken for
 * absence. See `apps/api/src/users/users.contract.ts:UserPhoneWire` for how the wire keeps
 * a staff assertion distinguishable from a future OTP on the same column.
 */

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly users: readonly UserSummary[];
      readonly groups: readonly Group[];
      readonly available: readonly string[];
    };

const STATUS_LABEL: Readonly<Record<UserSummary['status'], string>> = {
  active: 'ใช้งานอยู่',
  suspended: 'ถูกระงับ',
  closed: 'ปิดบัญชีแล้ว',
  erased: 'ลบข้อมูลแล้ว',
};

export function UserAdmin() {
  const { can, state: session } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [suspending, setSuspending] = useState<UserSummary | null>(null);
  const [editingGroups, setEditingGroups] = useState<UserSummary | null>(null);

  /*
   * ⚠️ Loaded separately from `users`/`groups`, and its failure is its own.
   *
   * `GET /quotes/authority/limits` is behind `groups.read` while this page's other two reads
   * are behind `users.read` — two different permissions, so a person can hold one and not the
   * other. Folding this into `reload()`'s `Promise.all` would turn a 403 on the ceilings into
   * "โหลดรายชื่อผู้ใช้ไม่สำเร็จ" and take the whole screen down for a tab they were never
   * entitled to see. Same split `organisation-screen.tsx` makes across its three sections.
   */
  const [limits, setLimits] = useState<AuthorityLimitsState>({ status: 'loading' });

  const editable = can('users.write');
  const mayReadLimits = can('groups.read');
  const mayWriteLimits = can('groups.write');
  const meId = session.status === 'signed-in' ? session.principal.userId : null;

  async function reload(): Promise<void> {
    try {
      const [users, groups] = await Promise.all([listUsers(), listGroups()]);
      setState({ status: 'ready', users, groups: groups.groups, available: groups.available });
    } catch (cause) {
      setState({ status: 'failed', message: failureMessage(cause) });
    }
  }

  async function reloadLimits(): Promise<void> {
    if (!mayReadLimits) return;
    try {
      const list = await listAuthorityLimits();
      setLimits({ status: 'ready', limits: list.limits, isFailClosed: list.isFailClosed });
    } catch (cause) {
      setLimits({ status: 'failed', problem: failureMessage(cause) });
    }
  }

  useEffect(() => {
    void reload();
    void reloadLimits();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  async function act(userId: string, run: () => Promise<unknown>, said: string): Promise<void> {
    setBusyId(userId);
    setProblem(null);
    setNote(null);
    try {
      await run();
      setNote(said);
      await reload();
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

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
          <UserCheck className="size-4" />
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}

      {state.status === 'loading' && <Skeleton className="h-64 w-full" />}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>โหลดรายชื่อผู้ใช้ไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && (
        <Tabs defaultValue="users">
          <TabsList>
            <TabsTrigger value="users">ผู้ใช้ ({state.users.length})</TabsTrigger>
            <TabsTrigger value="groups">กลุ่มและสิทธิ์ ({state.groups.length})</TabsTrigger>
            {/*
             * Behind `groups.read`, which is not `users.read`. Hiding the tab rather than
             * showing an empty one is the same call `visibleNavigation` makes about a nav entry
             * whose permission the person does not hold — the enforcement is
             * `@RequirePermissions` on the route either way.
             */}
            {mayReadLimits && <TabsTrigger value="authority">อำนาจอนุมัติ</TabsTrigger>}
          </TabsList>

          <TabsContent value="users" className="flex flex-col gap-4">
            {editable && (
              <div>
                <Button onClick={() => setCreating(true)}>
                  <Plus className="size-4" />
                  เพิ่มผู้ใช้
                </Button>
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle>ผู้ใช้ทั้งหมด</CardTitle>
                <CardDescription>
                  สิทธิ์มาจากกลุ่มเสมอ — ผู้ใช้ไม่ได้ถือสิทธิ์โดยตรง
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ผู้ใช้</TableHead>
                      <TableHead>เบอร์โทร</TableHead>
                      <TableHead>สถานะ</TableHead>
                      <TableHead>กลุ่ม</TableHead>
                      <TableHead>เซสชัน</TableHead>
                      {editable && <TableHead className="text-right">การจัดการ</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.users.map((user) => {
                      const isMe = user.id === meId;
                      const busy = busyId === user.id;

                      return (
                        <TableRow key={user.id} className={user.status === 'active' ? undefined : 'opacity-70'}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="flex items-center gap-2">
                                {user.displayName ?? '(ไม่มีชื่อ)'}
                                {isMe && <Badge variant="secondary">คุณ</Badge>}
                              </span>
                              <span className="text-muted-foreground text-xs">
                                {user.emails.join(' · ') || 'ไม่มีอีเมลที่ยืนยันแล้ว'}
                              </span>
                            </div>
                          </TableCell>

                          <TableCell>
                            <PhoneList
                              phones={user.phones}
                              editable={editable}
                              busy={busy}
                              onVerify={(phone) =>
                                void act(
                                  user.id,
                                  () => verifyPhone(user.id, phone.id),
                                  `ยืนยันเบอร์ ${phone.number} แล้ว`,
                                )
                              }
                              onUnverify={(phone) =>
                                void act(
                                  user.id,
                                  () => unverifyPhone(user.id, phone.id),
                                  `ยกเลิกการยืนยันเบอร์ ${phone.number} แล้ว`,
                                )
                              }
                            />
                          </TableCell>

                          <TableCell>
                            {user.status === 'active' ? (
                              <Badge variant="outline">{STATUS_LABEL[user.status]}</Badge>
                            ) : (
                              <Badge variant="destructive">{STATUS_LABEL[user.status]}</Badge>
                            )}
                          </TableCell>

                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {user.groups.length === 0 ? (
                                <span className="text-muted-foreground text-sm">ไม่มีกลุ่ม</span>
                              ) : (
                                user.groups.map((group) => (
                                  <Badge key={group.id} variant="outline" title={group.code}>
                                    {group.nameTh}
                                  </Badge>
                                ))
                              )}
                            </div>
                            {user.permissions.length > 0 && (
                              <span className="text-muted-foreground text-xs">
                                {user.permissions.length} สิทธิ์
                              </span>
                            )}
                          </TableCell>

                          <TableCell className="text-sm">{user.liveSessions}</TableCell>

                          {editable && (
                            <TableCell className="text-right">
                              <div className="flex flex-wrap items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy || isMe}
                                  onClick={() => setEditingGroups(user)}
                                  title={isMe ? 'แก้สิทธิ์ของตัวเองไม่ได้' : undefined}
                                >
                                  กลุ่ม
                                </Button>

                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      user.id,
                                      () => sendPasswordLink(user.id),
                                      `ส่งลิงก์ตั้งรหัสผ่านไปที่ ${user.emails[0] ?? 'อีเมลของผู้ใช้'} แล้ว`,
                                    )
                                  }
                                >
                                  <KeyRound className="size-4" />
                                  ส่งลิงก์รหัสผ่าน
                                </Button>

                                {/*
                                  Separate from suspension, and the wording says which is
                                  which. "My laptop was stolen" must not stop somebody
                                  working tomorrow.
                                */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy || isMe || user.liveSessions === 0}
                                  onClick={() =>
                                    void act(
                                      user.id,
                                      () => revokeSessions(user.id),
                                      'ออกจากระบบทุกอุปกรณ์ของบัญชีนี้แล้ว',
                                    )
                                  }
                                >
                                  <LogOut className="size-4" />
                                  ออกจากระบบ
                                </Button>

                                {/*
                                  * ⭐ Disabled for your own row, and the title says why.
                                  *
                                  * Self-service disabling costs the account's password;
                                  * this route asks for none, because an administrator does
                                  * not have somebody else's. Pointed at yourself the two
                                  * combine into a way round the password rule, so the API
                                  * refuses it — and the button says so before the 409 does.
                                  */}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy || isMe}
                                  title={
                                    isMe
                                      ? 'ปิด MFA ของตัวเองที่นี่ไม่ได้ — ไปที่หน้าบัญชีของฉัน ซึ่งจะถามรหัสผ่าน'
                                      : 'ใช้เมื่อเจ้าตัวทำอุปกรณ์ยืนยันตัวตนหายและรหัสสำรองหมด'
                                  }
                                  onClick={() =>
                                    void act(
                                      user.id,
                                      () => disableUserMfa(user.id),
                                      'ปิดการยืนยันสองขั้นให้แล้ว',
                                    )
                                  }
                                >
                                  <ShieldOff className="size-4" />
                                  ปิด MFA
                                </Button>

                                {user.status === 'suspended' ? (
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      void act(user.id, () => reinstateUser(user.id), 'ปลดระงับบัญชีแล้ว')
                                    }
                                  >
                                    ปลดระงับ
                                  </Button>
                                ) : (
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    disabled={busy || isMe || user.status !== 'active'}
                                    onClick={() => setSuspending(user)}
                                    title={isMe ? 'ระงับบัญชีของตัวเองไม่ได้' : undefined}
                                  >
                                    <ShieldOff className="size-4" />
                                    ระงับ
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="groups">
            <GroupsPanel
              groups={state.groups}
              available={state.available}
              editable={editable}
              onChanged={() => void reload()}
              onProblem={setProblem}
            />
          </TabsContent>

          {mayReadLimits && (
            <TabsContent value="authority">
              <AuthorityLimitsPanel
                state={limits}
                groups={state.groups}
                editable={mayWriteLimits}
                onChanged={reloadLimits}
              />
            </TabsContent>
          )}
        </Tabs>
      )}

      {creating && state.status === 'ready' && (
        <CreateUserDialog
          groups={state.groups}
          onClose={() => setCreating(false)}
          onCreated={(invitationSent) => {
            setCreating(false);
            setNote(
              invitationSent
                ? 'สร้างบัญชีแล้ว และส่งลิงก์ตั้งรหัสผ่านไปให้เรียบร้อย'
                : 'สร้างบัญชีแล้ว แต่ส่งอีเมลไม่สำเร็จ — ใช้ปุ่ม "ส่งลิงก์รหัสผ่าน" อีกครั้งได้',
            );
            void reload();
          }}
        />
      )}

      {suspending !== null && (
        <SuspendDialog
          user={suspending}
          onClose={() => setSuspending(null)}
          onDone={() => {
            setSuspending(null);
            setNote('ระงับบัญชีแล้ว และออกจากระบบทุกอุปกรณ์ของบัญชีนี้');
            void reload();
          }}
        />
      )}

      {/*
        * ⭐ Last on the page, and present rather than hidden behind a tab.
        *
        * Every action above it writes a row here, in the same transaction. Putting the
        * record where the actions are is what makes it get read — an audit behind a
        * navigation step is one nobody opens until there is already an incident.
        */}
      {state.status === 'ready' && <AuditTrail />}

      {editingGroups !== null && state.status === 'ready' && (
        <UserGroupsDialog
          user={editingGroups}
          groups={state.groups}
          onClose={() => setEditingGroups(null)}
          onSaved={() => {
            setEditingGroups(null);
            setNote('บันทึกกลุ่มแล้ว');
            void reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * Every telephone claim on one account, each carrying its own verified state.
 *
 * Unlike the emails line above it in the identity cell, an unverified number is shown here
 * rather than filtered out — the badge says which it is, so nothing reads as a fact it is
 * not, and the button has a row to attach to.
 */
function PhoneList({
  phones,
  editable,
  busy,
  onVerify,
  onUnverify,
}: {
  readonly phones: readonly UserPhone[];
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onVerify: (phone: UserPhone) => void;
  readonly onUnverify: (phone: UserPhone) => void;
}) {
  if (phones.length === 0) {
    return <span className="text-muted-foreground text-sm">ไม่มีเบอร์โทร</span>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {phones.map((phone) => {
        const verified = phone.verifiedAt !== null;

        return (
          <div key={phone.id} className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs">{phone.number}</span>
            <Badge variant={verified ? 'outline' : 'secondary'}>
              {verified ? 'ยืนยันแล้ว' : 'ยังไม่ยืนยัน'}
            </Badge>

            {editable &&
              (verified ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || phone.isPrimary}
                  title={
                    /*
                     * `user_phones_primary_is_verified` demands a primary number stay
                     * verified — the API refuses this too, this just says why before the
                     * 409 does.
                     */
                    phone.isPrimary
                      ? 'ยกเลิกยืนยันเบอร์หลักไม่ได้ — ตั้งเบอร์อื่นเป็นเบอร์หลักก่อน'
                      : undefined
                  }
                  onClick={() => onUnverify(phone)}
                >
                  <PhoneOff className="size-3.5" />
                  ยกเลิกยืนยัน
                </Button>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onVerify(phone)}>
                  <Phone className="size-3.5" />
                  ยืนยันเบอร์
                </Button>
              ))}
          </div>
        );
      })}
    </div>
  );
}
