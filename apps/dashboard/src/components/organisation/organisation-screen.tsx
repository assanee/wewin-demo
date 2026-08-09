'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Loader2, Pencil, Plus } from 'lucide-react';
import type { BankAccountWire, OrganisationProfileWire } from '@wewin/contract/organisation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { FieldGroup } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TextField } from '@/components/products/form-field';
import { failureMessage } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';

import { BankAccountDialog } from './bank-account-dialog';
import { BankAccountHistoryDialog } from './bank-account-history';
import { getProfile, listBankAccounts, putProfile, setBankAccountAvailability } from './organisation-api';
import {
  fieldsFromProfile,
  profileFormErrors,
  profileFormReady,
  profileRequest,
  type ProfileFields,
} from './profile-form';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The company profile, and the accounts it is paid into.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two sections, and they are independent screens sharing one page rather than one form: the
 * profile is a single row a staff member edits a few times a year, and the bank-account list
 * is a queue with its own history control. Loading, saving and failing are tracked separately
 * for each, so a slow `bank-accounts` fetch cannot leave the profile form looking broken, and
 * a rejected profile save cannot disable the account list.
 *
 * ⚠️ **Retired accounts are shown greyed, never hidden.** `listBankAccounts` reads Task 9's
 * `GET bank-accounts`, which returns `is_active = false` rows deliberately — an administrator
 * auditing what was retired, and when, has to be able to see the row, not just the ones still
 * receiving money. `AccountsTable` below renders every row the API sends and dims the inactive
 * ones with the same `opacity-60` treatment `option-group-card.tsx` uses for an unavailable
 * catalogue value, rather than filtering them out of the array.
 */

type ProfileState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly profile: OrganisationProfileWire };

type AccountsState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'ready'; readonly accounts: readonly BankAccountWire[] };

export function OrganisationScreen() {
  const { can } = useSession();
  const editable = can('organisation.write');

  const [profileState, setProfileState] = useState<ProfileState>({ status: 'loading' });
  const [accountsState, setAccountsState] = useState<AccountsState>({ status: 'loading' });

  const reloadProfile = async (): Promise<void> => {
    try {
      setProfileState({ status: 'ready', profile: await getProfile() });
    } catch (cause) {
      setProfileState({ status: 'failed', problem: failureMessage(cause) });
    }
  };

  const reloadAccounts = async (): Promise<void> => {
    try {
      setAccountsState({ status: 'ready', accounts: await listBankAccounts() });
    } catch (cause) {
      setAccountsState({ status: 'failed', problem: failureMessage(cause) });
    }
  };

  useEffect(() => {
    void reloadProfile();
    void reloadAccounts();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <ProfileCard state={profileState} editable={editable} onSaved={reloadProfile} />
      <AccountsCard state={accountsState} editable={editable} onChanged={reloadAccounts} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The company profile
 * ------------------------------------------------------------------ */

function ProfileCard({
  state,
  editable,
  onSaved,
}: {
  readonly state: ProfileState;
  readonly editable: boolean;
  readonly onSaved: () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>ข้อมูลบริษัท</CardTitle>
        <CardDescription>
          ชื่อ ที่อยู่ เบอร์โทร และเลขผู้เสียภาษี — ข้อมูลนี้จะพิมพ์อยู่บนใบเสนอราคาทุกใบที่ออกจากนี้ไป
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === 'loading' && <Skeleton className="h-72 w-full" />}

        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>โหลดข้อมูลบริษัทไม่สำเร็จ</AlertTitle>
            <AlertDescription>{state.problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && (
          <ProfileForm profile={state.profile} editable={editable} onSaved={onSaved} />
        )}
      </CardContent>
    </Card>
  );
}

function ProfileForm({
  profile,
  editable,
  onSaved,
}: {
  readonly profile: OrganisationProfileWire;
  readonly editable: boolean;
  readonly onSaved: () => Promise<void>;
}) {
  const initial = useMemo(() => fieldsFromProfile(profile), [profile]);
  const [fields, setFields] = useState<ProfileFields>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /*
   * Derived during render rather than a `useEffect` — `fields-form.tsx` sets the precedent
   * for this exact shape. `initial` is a fresh object on every reload (including the one
   * `onSaved` triggers right after a successful save), so this is also what quietly clears
   * `saved` the moment a new save begins to diverge from what was last confirmed.
   */
  const [baseline, setBaseline] = useState(initial);
  if (baseline !== initial) {
    setBaseline(initial);
    setFields(initial);
  }

  const set = (key: keyof ProfileFields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const errors = profileFormErrors(fields);
  const ready = profileFormReady(fields);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      await putProfile(profileRequest(fields));
      await onSaved();
      setSaved(true);
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const disabled = !editable || busy;

  return (
    <div className="flex flex-col gap-4">
      {problem !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>บันทึกไม่สำเร็จ</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {saved && !busy && (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertDescription>บันทึกข้อมูลบริษัทแล้ว</AlertDescription>
        </Alert>
      )}

      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <TextField
          label="ชื่อบริษัท (ไทย)"
          value={fields.legalNameTh}
          onChange={set('legalNameTh')}
          disabled={disabled}
        />
        <TextField
          label="ชื่อบริษัท (อังกฤษ)"
          description="ไม่บังคับ"
          value={fields.legalNameEn}
          onChange={set('legalNameEn')}
          disabled={disabled}
        />
        <TextField
          label="ที่อยู่ (ไทย)"
          value={fields.addressTh}
          onChange={set('addressTh')}
          disabled={disabled}
          multiline
        />
        <TextField
          label="ที่อยู่ (อังกฤษ)"
          description="ไม่บังคับ"
          value={fields.addressEn}
          onChange={set('addressEn')}
          disabled={disabled}
          multiline
        />
        <TextField
          label="เลขผู้เสียภาษี"
          description="ตัวเลข 13 หลัก ไม่บังคับ"
          value={fields.taxId}
          onChange={set('taxId')}
          error={errors.taxId}
          disabled={disabled}
          mono
        />
        <TextField
          label="เบอร์โทร"
          value={fields.phone}
          onChange={set('phone')}
          disabled={disabled}
        />
        <TextField
          label="อีเมล"
          description="ไม่บังคับ"
          value={fields.email}
          onChange={set('email')}
          error={errors.email}
          disabled={disabled}
        />
      </FieldGroup>

      {editable && (
        <div>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            บันทึก
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The bank accounts
 * ------------------------------------------------------------------ */

function AccountsCard({
  state,
  editable,
  onChanged,
}: {
  readonly state: AccountsState;
  readonly editable: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<'create' | BankAccountWire | null>(null);
  const [historyOf, setHistoryOf] = useState<BankAccountWire | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function toggle(account: BankAccountWire): Promise<void> {
    setPendingId(account.id);
    setProblem(null);
    try {
      await setBankAccountAvailability(account.id, !account.isActive);
      await onChanged();
    } catch (cause) {
      setProblem(failureMessage(cause));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>บัญชีธนาคารที่รับเงิน</CardTitle>
            <CardDescription>
              บัญชีที่ลูกค้าเห็นเป็นทางเลือกโอนเงิน — ปิดใช้งานได้โดยไม่ต้องลบ บัญชีที่ปิดแล้วยังแสดงอยู่ที่นี่
              (จางลง) และประวัติการแก้ไขทุกครั้งเก็บไว้ถาวร
            </CardDescription>
          </div>
          {editable && (
            <Button size="sm" onClick={() => setDialog('create')}>
              <Plus className="size-4" />
              เพิ่มบัญชี
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {problem !== null && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>ทำรายการไม่สำเร็จ</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'loading' && <Skeleton className="h-40 w-full" />}

        {state.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>โหลดบัญชีธนาคารไม่สำเร็จ</AlertTitle>
            <AlertDescription>{state.problem}</AlertDescription>
          </Alert>
        )}

        {state.status === 'ready' && state.accounts.length === 0 && (
          <Empty className="border-border/60 rounded-lg border border-dashed">
            <EmptyHeader>
              <EmptyTitle>ยังไม่มีบัญชีธนาคาร</EmptyTitle>
              <EmptyDescription>เพิ่มบัญชีแรกเพื่อให้ลูกค้าเห็นตอนชำระเงิน</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {state.status === 'ready' && state.accounts.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ธนาคาร</TableHead>
                <TableHead>เลขบัญชี</TableHead>
                <TableHead>ชื่อบัญชี</TableHead>
                <TableHead>พร้อมเพย์</TableHead>
                <TableHead>สถานะ</TableHead>
                <TableHead className="text-right">การจัดการ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.accounts.map((account) => (
                <TableRow key={account.id} className={account.isActive ? undefined : 'opacity-60'}>
                  <TableCell className="font-mono text-sm">{account.bankCode}</TableCell>
                  <TableCell className="font-mono text-sm">{account.accountNumber}</TableCell>
                  <TableCell>{account.accountName}</TableCell>
                  <TableCell className="font-mono text-sm">{account.promptpayId ?? '—'}</TableCell>
                  <TableCell>
                    {account.isActive ? (
                      <Badge variant="outline">ใช้งาน</Badge>
                    ) : (
                      <Badge variant="destructive">ปิดใช้งาน</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setHistoryOf(account)}>
                        <History className="size-4" />
                        ประวัติ
                      </Button>

                      {editable && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setDialog(account)}>
                            <Pencil className="size-4" />
                            แก้ไข
                          </Button>
                          <Button
                            variant={account.isActive ? 'destructive' : 'secondary'}
                            size="sm"
                            disabled={pendingId === account.id}
                            onClick={() => void toggle(account)}
                          >
                            {pendingId === account.id && <Loader2 className="size-4 animate-spin" />}
                            {account.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {dialog !== null && (
        <BankAccountDialog
          account={dialog === 'create' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void onChanged();
          }}
        />
      )}

      {historyOf !== null && (
        <BankAccountHistoryDialog account={historyOf} onClose={() => setHistoryOf(null)} />
      )}
    </Card>
  );
}
