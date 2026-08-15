'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, LogOut, Phone, PhoneOff, Plus, ShieldOff } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { toast } from 'sonner';

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
import { accessFocus, STATUS_LABEL_TH } from './access-focus';
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
 * ── ⚠️ The ceiling table is NOT a tab here, and must not become one again ────────
 *
 * It was, for one round: อำนาจอนุมัติ beside กลุ่มและสิทธิ์, on the reasoning that authority
 * attaches to a group and groups are administered here. The consequence was invisible from
 * inside this file. This route requires `users.read` — the whole staff directory — so a person
 * holding `groups.read` + `groups.write`, the permissions that actually own `authority_limits`,
 * could not reach it, and `groups.write` is held by nobody at boot. It lives at `/authority`
 * now, behind `groups.read` alone, with its own role-picker endpoint so it needs nothing from
 * this screen. See `components/authority/authority-screen.tsx`.
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

export function UserAdmin() {
  const { can, state: session } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
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

  /**
   * ⚠️ **Toasts, not the banner this used to render.**
   *
   * The banner was not missing and it was not empty — it was pinned to the top of this component,
   * above the tab strip and above an unpaginated table of every account. Press ส่งลิงก์รหัสผ่าน on
   * a row two thirds of the way down and the answer appears two thousand pixels behind you, so the
   * screen looked like it had done nothing at all. It reported the API's sentence faithfully to a
   * part of the page nobody was looking at, which is worse than saying nothing: the operator's
   * next move is to press it again.
   *
   * `act` is shared by every row action here — groups, sign-out, MFA, suspension — so all of them
   * were equally silent and all of them are fixed by this one change. `sonner` is what the rest of
   * this dashboard already uses; `record-payment-dialog.tsx` is the pattern being copied.
   */
  async function act(userId: string, run: () => Promise<unknown>, said: string): Promise<void> {
    setBusyId(userId);
    try {
      await run();
      toast.success(said);
      await reload();
    } catch (cause) {
      toast.error(failureMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    /* `gap-8` and not the `gap-4` this was: with the Cards gone, space is what separates the
     * focal statement, the tabs and the audit trail from one another — see `overview-screen.tsx`,
     * which makes the same trade of a ring for a gap. */
    <div className="flex flex-col gap-8">
      {state.status === 'loading' && <Skeleton className="h-64 w-full" />}

      {state.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>โหลดรายชื่อผู้ใช้ไม่สำเร็จ</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === 'ready' && (
        <>
          {/*
           * ⭐ THE PRIMARY THING: the state of access. On the page ground, no border.
           *
           * This screen used to go straight from its title into a tab strip, so the first thing
           * a reader met was a navigation choice rather than an answer. The one fact somebody
           * might have to *act* on here is that an account has lost access — and it was a badge
           * in the third column of whichever row happened to hold it.
           *
           * Above the tabs rather than inside the ผู้ใช้ one: it is true of the screen, not of a
           * tab, and `type-focal` is allowed once per screen. The gap between it and the tab
           * strip is what says the tabs are subordinate to it.
           */}
          <AccessFocusLine users={state.users} />

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

              {/*
               * ⚠️ No `<Card>` around this table, and the `CardTitle` that said "ผู้ใช้ทั้งหมด" is
               * gone with it. The table was the *only* thing in that card, its title repeated the
               * tab label two centimetres above it, and a table is already a grid of rules — the
               * ring was an edge drawn around an edge.
               *
               * The card's description survives, because it is the one thing in that header that
               * was not a restatement: where permissions come from is a rule about this table that
               * the table cannot show.
               */}
              <p className="text-muted-foreground type-body">
                สิทธิ์มาจากกลุ่มเสมอ — ผู้ใช้ไม่ได้ถือสิทธิ์โดยตรง
              </p>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="type-caption h-8">ผู้ใช้</TableHead>
                      <TableHead className="type-caption h-8">เบอร์โทร</TableHead>
                      <TableHead className="type-caption h-8">สถานะ</TableHead>
                      <TableHead className="type-caption h-8">กลุ่ม</TableHead>
                      {/* Slack to the *last rendered* column — see `order-list.tsx`. Without it the
                        identity, the phone and the status drift apart across a wide screen. Which
                        column is last depends on `editable`, so `w-full` moves with it rather than
                        disappearing for a reader who may only look. */}
                      <TableHead
                        className={editable ? 'type-caption h-8' : 'type-caption h-8 w-full'}
                      >
                        เซสชัน
                      </TableHead>
                      {editable && (
                        <TableHead className="type-caption h-8 w-full text-right">
                          การจัดการ
                        </TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.users.map((user) => {
                      const isMe = user.id === meId;
                      const busy = busyId === user.id;

                      return (
                        <TableRow
                          key={user.id}
                          className={user.status === 'active' ? undefined : 'opacity-70'}
                        >
                          <TableCell className="px-2 py-1.5">
                            <div className="flex flex-col">
                              <span className="type-body flex items-center gap-2">
                                {user.displayName ?? '(ไม่มีชื่อ)'}
                                {isMe && <Badge variant="secondary">คุณ</Badge>}
                              </span>
                              <span className="text-muted-foreground type-caption">
                                {user.emails.join(' · ') || 'ไม่มีอีเมลที่ยืนยันแล้ว'}
                              </span>
                            </div>
                          </TableCell>

                          <TableCell className="px-2 py-1.5">
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

                          <TableCell className="px-2 py-1.5">
                            {user.status === 'active' ? (
                              <Badge variant="outline">{STATUS_LABEL_TH[user.status]}</Badge>
                            ) : (
                              <Badge variant="destructive">{STATUS_LABEL_TH[user.status]}</Badge>
                            )}
                          </TableCell>

                          <TableCell className="px-2 py-1.5">
                            <div className="flex flex-wrap gap-1">
                              {user.groups.length === 0 ? (
                                <span className="text-muted-foreground type-body">ไม่มีกลุ่ม</span>
                              ) : (
                                user.groups.map((group) => (
                                  <Badge key={group.id} variant="outline" title={group.code}>
                                    {group.nameTh}
                                  </Badge>
                                ))
                              )}
                            </div>
                            {user.permissions.length > 0 && (
                              <span className="text-muted-foreground type-caption">
                                {user.permissions.length} สิทธิ์
                              </span>
                            )}
                          </TableCell>

                          <TableCell className="type-body px-2 py-1.5 tabular-nums">
                            {user.liveSessions}
                          </TableCell>

                          {editable && (
                            <TableCell className="px-2 py-1.5 text-right">
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
                                      void act(
                                        user.id,
                                        () => reinstateUser(user.id),
                                        'ปลดระงับบัญชีแล้ว',
                                      )
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
              </div>
            </TabsContent>

            <TabsContent value="groups">
              <GroupsPanel
                groups={state.groups}
                available={state.available}
                editable={editable}
                onChanged={() => void reload()}
                onProblem={(message) => toast.error(message)}
              />
            </TabsContent>
          </Tabs>
        </>
      )}

      {creating && state.status === 'ready' && (
        <CreateUserDialog
          groups={state.groups}
          onClose={() => setCreating(false)}
          onCreated={(invitationSent) => {
            setCreating(false);
            /* ⚠️ The failure half is a `warning`, not a `success`: the account exists but nobody
               can sign into it yet, and a green tick over that sentence contradicts it. */
            if (invitationSent) {
              toast.success('สร้างบัญชีแล้ว และส่งลิงก์ตั้งรหัสผ่านไปให้เรียบร้อย');
            } else {
              toast.warning('สร้างบัญชีแล้ว แต่ส่งอีเมลไม่สำเร็จ — ใช้ปุ่ม "ส่งลิงก์รหัสผ่าน" อีกครั้งได้');
            }
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
            toast.success('ระงับบัญชีแล้ว และออกจากระบบทุกอุปกรณ์ของบัญชีนี้');
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
            toast.success('บันทึกกลุ่มแล้ว');
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
    return <span className="text-muted-foreground type-body">ไม่มีเบอร์โทร</span>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {phones.map((phone) => {
        const verified = phone.verifiedAt !== null;

        return (
          <div key={phone.id} className="flex flex-wrap items-center gap-1.5">
            <span className="type-caption font-mono">{phone.number}</span>
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

/**
 * ⭐ The screen's one primary statement, as its own component.
 *
 * Extracted rather than inlined into the `ready` branch for a dull reason worth stating: the
 * sentence has two parts that both come from `accessFocus`, and calling it once per part inside
 * JSX would run the count twice per render to say one thing. `state` is a discriminated union
 * so the value cannot be hoisted above the `return`; a component is where it goes.
 *
 * ⚠️ Only rendered once the list has arrived, and that is safe here because `PageHeader` lives in
 * `page.tsx` — the screen keeps its name in the loading and failure states even though it loses
 * this line, which is the rule `page-header.tsx` states.
 */
function AccessFocusLine({ users }: { readonly users: readonly UserSummary[] }) {
  const focus = accessFocus(users);

  return (
    <section className="flex flex-col gap-1">
      <p className="type-focal text-balance">{focus.headlineTh}</p>
      {focus.detailTh === null ? null : (
        <p className="text-muted-foreground type-body">{focus.detailTh}</p>
      )}
    </section>
  );
}
