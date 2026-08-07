'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, LogOut, Plus, ShieldOff, UserCheck } from 'lucide-react';

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
  revokeSessions,
  sendPasswordLink,
  type Group,
  type UserSummary,
} from './user-api';
import { CreateUserDialog } from './create-user-dialog';
import { GroupsPanel } from './groups-panel';
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

  const editable = can('users.write');
  const meId = session.status === 'signed-in' ? session.principal.userId : null;

  async function reload(): Promise<void> {
    try {
      const [users, groups] = await Promise.all([listUsers(), listGroups()]);
      setState({ status: 'ready', users, groups: groups.groups, available: groups.available });
    } catch (cause) {
      setState({ status: 'failed', message: failureMessage(cause) });
    }
  }

  useEffect(() => {
    void reload();
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
