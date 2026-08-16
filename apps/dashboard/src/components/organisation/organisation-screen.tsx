'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Loader2, Pencil, Plus } from 'lucide-react';
import type { BankAccountWire, OrganisationProfileWire } from '@wewin/contract/organisation';
import { isPromptPayId } from '@wewin/core/promptpay';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TextField } from '@/components/products/form-field';
import { failureMessage } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';

import { BankAccountDialog } from './bank-account-dialog';
import { BankAccountHistoryDialog } from './bank-account-history';
import { FxHealthSection, type FxHealthState } from './fx-health';
import { getFxRateHealth } from './fx-health-api';
import { getProfile, listBankAccounts, listTaxCountries, putProfile, setBankAccountAvailability } from './organisation-api';
import { ProfileHistoryDialog } from './profile-history';
import {
  fieldsFromProfile,
  profileFormErrors,
  profileFormReady,
  profileRequest,
  type ProfileFields,
} from './profile-form';
import TaxCountriesSection, { type TaxCountriesState } from './tax-countries';
import { ForfeitPolicySection } from './forfeit-policy-section';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The company profile, the accounts it is paid into, and the destinations it taxes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Four sections, and they are independent screens sharing one page rather than one form: the
 * profile is a single row a staff member edits a few times a year, the bank-account list is a
 * queue with its own history control, the exchange-rate health report is read-only, and
 * the tax-country table is a short, mostly-static list with a history control of its own.
 * Loading, saving and failing are tracked separately for each, so a slow `bank-accounts` fetch
 * cannot leave the profile form looking broken, and a rejected profile save cannot disable the
 * account list or the tax table.
 *
 * ── ⭐ Four unrelated jobs, and only one of them can be *wrong right now* ─────
 *
 * That is what decides the order of this page, and the order changed. The profile, the bank
 * accounts and the tax destinations are near-static configuration: they are exactly as somebody
 * last typed them, and a screen full of them has nothing to report. **The exchange-rate feed is
 * the only thing here with a live state that can have gone bad while nobody was looking** — the
 * rate ages by itself, and past `refuseAfterHours` every foreign-currency quotation in the company
 * is being refused. So its verdict is now this screen's one `type-focal` statement and it opens
 * the page; the three configuration blocks are `type-section` bands underneath it.
 *
 * ⚠️ **The `type-focal` line lives in `fx-health.tsx`, not here.** "At most once per screen" is the
 * rule, and the sentence is `fxHealthTitleTh(health)` — a function of a payload only that file
 * holds. Nothing else on this page may use `type-focal`; the four bands are all `type-section`.
 *
 * ⚠️ **`FxHealthSection` still sits above `TaxCountriesSection`, and the adjacency is still the
 * point.** It is the only section here that sets nothing at all — its own header says so — and
 * the way out of everything it reports is one text box in the table underneath it:
 * `อัตราแลกเปลี่ยนกำหนดเอง` on the destination being quoted. A page that named a remedy on a
 * different screen, or that put the diagnosis at the top and the cure at the bottom, would be
 * asking a person to hold a sentence in their head while they scrolled — which is why the tax
 * table was promoted with it rather than left where it was. `fxHealthRemedyTh` says
 * "ในตารางประเทศปลายทางด้านล่าง" in so many words, and that sentence has to keep being true. It
 * reads its own endpoint (`GET /admin/fx/health`, `admin/fx` and not `admin/organisation` —
 * `fx-health-api.ts` records why) and fails on its own, so a rate feed this dashboard cannot reach
 * still leaves the profile, the accounts and the destinations editable.
 *
 * ── ⚠️ The page title and the first heading used to be the same six characters ─
 *
 * `<h1>ข้อมูลบริษัท</h1>` sat about twenty pixels above `<CardTitle>ข้อมูลบริษัท</CardTitle>`, at
 * 24px and 16px, which reads as one heading rendered twice by mistake. The page keeps the name —
 * it is what the sidebar says, and a screen whose title disagrees with the link that opened it is
 * worse — and the section is now named for what is actually in it: `ชื่อ ที่อยู่ และเลขผู้เสียภาษี`.
 *
 * ── No `Card` survives on this screen ────────────────────────────────────────
 *
 * Every one of the four failed the three questions in the README. Two of them wrap a `<Table>`,
 * which draws its own rules — a ring around one is an edge around an edge, and the rule is
 * explicit. The profile is a form whose inputs draw their own boxes. The exchange-rate report is
 * the page's opening statement and cannot be inside a container that says "one item among
 * several". `gap-10` and `type-section` do the separating, as they do on `/account`.
 *
 * ⚠️ **The profile's own `ประวัติ` control is simpler than either sibling's, on purpose.** A bank
 * account and a tax country are both rows in a list — `AccountsSection`/`TaxCountriesSection` open
 * their history dialog against *one* row a person picked from a table. `organisation_profile` is
 * a singleton: there is no row to pick, so `ProfileSection` just opens `ProfileHistoryDialog` with
 * no argument at all. It answers the same question `depositBp` made worth answering: who lowered
 * the approval floor, and when — see `profile-history.tsx` and `profile-changes.ts`.
 *
 * ⚠️ **Retired accounts are shown greyed, never hidden.** `listBankAccounts` reads Task 9's
 * `GET bank-accounts`, which returns `is_active = false` rows deliberately — an administrator
 * auditing what was retired, and when, has to be able to see the row, not just the ones still
 * receiving money. `AccountsTable` below renders every row the API sends and dims the inactive
 * ones with the same `opacity-60` treatment `option-group-section.tsx` uses for an unavailable
 * catalogue value, rather than filtering them out of the array. `TaxCountriesSection` makes the
 * identical choice for a withdrawn destination, for the identical reason.
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
  const [taxCountriesState, setTaxCountriesState] = useState<TaxCountriesState>({ status: 'loading' });
  const [fxHealthState, setFxHealthState] = useState<FxHealthState>({ status: 'loading' });

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

  const reloadTaxCountries = async (): Promise<void> => {
    try {
      setTaxCountriesState({ status: 'ready', taxCountries: await listTaxCountries() });
    } catch (cause) {
      setTaxCountriesState({ status: 'failed', problem: failureMessage(cause) });
    }
  };

  /**
   * ⚠️ Its own `catch`, like every sibling above, and here the alternative is worse than usual: a
   * throw that reached the caller would leave this card on its skeleton for ever, which reads as
   * "still checking" — the one thing a staleness report must never imply while it knows nothing.
   * `failureMessage` puts the reason on the card instead, and `FxHealthSection` says out loud that a
   * failure to *read* the status is not a statement about the rate.
   */
  const reloadFxHealth = async (): Promise<void> => {
    try {
      setFxHealthState({ status: 'ready', health: await getFxRateHealth() });
    } catch (cause) {
      setFxHealthState({ status: 'failed', problem: failureMessage(cause) });
    }
  };

  useEffect(() => {
    void reloadProfile();
    void reloadAccounts();
    void reloadFxHealth();
    void reloadTaxCountries();
  }, []);

  return (
    <div className="flex flex-col gap-10">
      {/* ⭐ First, because it is the only thing on this page that can be wrong right now, and it
          carries the screen's one `type-focal` statement. See this file's header.

          ⚠️ This used to carry neither prop, with the note *"nothing on this card writes
          anything, so there is no permission to gate and nothing to reload after"*. It now
          carries both, and the reason is one control: ซิงก์เดี๋ยวนี้ asks the provider for a rate
          on demand. It still *sets* nothing — see the section's own header — but it is gated on
          `organisation.write` like every other action on this page, and a sync that brought a new
          observation in has to redraw the figures it moved, which is `reloadFxHealth`. */}
      <FxHealthSection state={fxHealthState} editable={editable} onSynced={reloadFxHealth} />
      {/* Immediately under the report, because the remedy the report names is a text box in this
          table. Promoted with it rather than left below the two blocks that have nothing to do
          with an exchange rate. */}
      <TaxCountriesSection state={taxCountriesState} editable={editable} onChanged={reloadTaxCountries} />

      {/*
       * ⭐ อัตราริบมัดจำ, beside the deposit percentage rather than on a page of its own: the two
       * are one subject — what happens to money when something goes wrong — and a person setting
       * the deposit is the same person who has an opinion about the forfeit.
       *
       * It loads itself rather than taking state from here, unlike its neighbours. It is the only
       * section whose write *publishes a new version* instead of editing a row, so it owns its
       * own reload; threading it through this component's state would suggest the parent could
       * refresh it, which would be a refresh of the wrong thing.
       */}
      <ForfeitPolicySection />
      <AccountsSection state={accountsState} editable={editable} onChanged={reloadAccounts} />
      {/* Last, and it is the slowest-moving thing here: a row somebody edits a few times a year.
          Being last also puts the most distance between the page's title and the heading that
          used to be the same string as it. */}
      <ProfileSection state={profileState} editable={editable} onSaved={reloadProfile} />
    </div>
  );
}

/**
 * One band of this page, and the shape all four share.
 *
 * A `<section>` with a `type-section` heading, the sentence that used to be its `CardDescription`
 * at `type-body` under it, and its own control (`ประวัติ`, `เพิ่มบัญชี`) on the right of the
 * heading row. `account-settings.tsx` settled this shape; the only addition here is `action`,
 * because three of these four bands have a button that belongs to the whole band.
 *
 * ⚠️ Written out here rather than imported by `tax-countries.tsx` and `fx-health.tsx` as well:
 * this module already imports both of those, so exporting a component *to* them would close an
 * import cycle for the sake of five lines of JSX. They spell their own heading rows instead.
 */
function Section({
  title,
  descriptionTh,
  action,
  children,
}: {
  readonly title: string;
  readonly descriptionTh: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="type-section">{title}</h2>
          <p className="text-muted-foreground type-body max-w-3xl">{descriptionTh}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The company profile
 * ------------------------------------------------------------------ */

/**
 * ⚠️ **Not called `ข้อมูลบริษัท` any more, and that is the whole of the fix.** The page's `<h1>` is
 * that string — it is what the sidebar calls this route — and this heading was the same six
 * characters twenty pixels below it. The section is named for the fields it actually contains.
 */
function ProfileSection({
  state,
  editable,
  onSaved,
}: {
  readonly state: ProfileState;
  readonly editable: boolean;
  readonly onSaved: () => Promise<void>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <Section
      title="ชื่อ ที่อยู่ และเลขผู้เสียภาษี"
      descriptionTh="ข้อมูลชุดนี้พิมพ์อยู่บนใบเสนอราคาทุกใบที่ออกจากนี้ไป ส่วนเปอร์เซ็นต์มัดจำเป็นนโยบาย — ต่ำกว่าที่ตั้งไว้ต้องขออนุมัติ"
      action={
        /* Needs only `organisation.read`, like `AccountsSection`/`TaxCountriesSection`'s own
           `ประวัติ` — GET /admin/organisation/changes carries no write permission at all, so
           this is not gated behind `editable`. */
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History className="size-4" />
          ประวัติ
        </Button>
      }
    >
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

      {historyOpen && <ProfileHistoryDialog onClose={() => setHistoryOpen(false)} />}
    </Section>
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
        <TextField
          label="เงินมัดจำก่อนเข้าผลิต (%)"
          description="ต่ำกว่านโยบายนี้ต้องขออนุมัติ"
          value={fields.depositPercent}
          onChange={set('depositPercent')}
          error={errors.depositPercent}
          suffix="%"
          disabled={disabled}
          mono
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

function AccountsSection({
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
    <Section
      title="บัญชีธนาคารที่รับเงิน"
      descriptionTh="บัญชีที่ลูกค้าเห็นเป็นทางเลือกโอนเงิน — ปิดใช้งานได้โดยไม่ต้องลบ บัญชีที่ปิดแล้วยังแสดงอยู่ที่นี่ (จางลง) และประวัติการแก้ไขทุกครั้งเก็บไว้ถาวร"
      action={
        editable && (
          <Button size="sm" onClick={() => setDialog('create')}>
            <Plus className="size-4" />
            เพิ่มบัญชี
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
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
          /* ⚠️ This was an `Empty` carrying `rounded-lg border border-dashed` **inside** the Card
             this section used to be — a box drawn inside a box, to say that a list with no rows
             has no rows. On the page ground there is nothing to separate it from, so there is
             nothing to draw a border around; `order-list.tsx` settled the same question the same
             way in phase 1. */
          <div className="flex flex-col items-center gap-1 py-10 text-center">
            <p className="type-body">ยังไม่มีบัญชีธนาคาร</p>
            <p className="text-muted-foreground type-caption">เพิ่มบัญชีแรกเพื่อให้ลูกค้าเห็นตอนชำระเงิน</p>
          </div>
        )}

        {state.status === 'ready' && state.accounts.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="type-caption h-8">ธนาคาร</TableHead>
                <TableHead className="type-caption h-8">เลขบัญชี</TableHead>
                <TableHead className="type-caption h-8">ชื่อบัญชี</TableHead>
                <TableHead className="type-caption h-8">พร้อมเพย์</TableHead>
                <TableHead className="type-caption h-8">สถานะ</TableHead>
                {/* `w-full` on the last column, which is the one holding the buttons: the slack
                    would otherwise be shared out between the five data columns and push facts
                    about one account apart across a wide screen. See `order-list.tsx`. */}
                <TableHead className="type-caption h-8 w-full text-right">การจัดการ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.accounts.map((account) => (
                <TableRow key={account.id} className={account.isActive ? undefined : 'opacity-60'}>
                  <TableCell className="type-body px-2 py-1.5 font-mono">{account.bankCode}</TableCell>
                  <TableCell className="type-body px-2 py-1.5 font-mono">
                    {account.accountNumber}
                  </TableCell>
                  <TableCell className="type-body px-2 py-1.5">{account.accountName}</TableCell>
                  {/*
                    ⭐ AN ID THAT CANNOT BECOME A QR, SAID OUT LOUD — the silent failure the
                    customer met and nobody here could see.

                    `1234567890` sat on the only active account in the dev database: ten
                    digits, so every validator in front of it agreed, and `promptPayTarget`
                    refused it because a Thai mobile number starts with `0`. The customer's
                    payment screen showed that account with no QR beside it, and this table —
                    the one screen belonging to the person who typed the number — printed the
                    value with nothing to suggest anything was wrong with it.

                    ⚠️ The tightened `bankAccountFormErrors` closes the door for *new* input
                    and can do nothing about rows already stored, which is why this exists as
                    well as that. It is read straight off the stored value through the
                    generator's own predicate, so it cannot disagree with what the storefront
                    will actually manage to render.

                    Deliberately **not** mirrored on the customer's screen. A missing QR is not
                    an error state for them: the account number and its copy button are the
                    payment path, the QR is a convenience, and "this account's PromptPay is
                    misconfigured" tells a customer about an internal fault they cannot act on
                    while giving them a reason to doubt the transfer. The person who can fix it
                    is the one looking at this table.
                  */}
                  <TableCell className="type-body px-2 py-1.5 font-mono">
                    <span className="flex items-center gap-2">
                      {account.promptpayId ?? '—'}
                      {account.promptpayId !== null && !isPromptPayId(account.promptpayId) ? (
                        <Badge variant="destructive" title="พร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลักขึ้นต้นด้วย 0 หรือเลขผู้เสียภาษี 13 หลัก">
                          สร้าง QR ไม่ได้
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    {account.isActive ? (
                      <Badge variant="outline">ใช้งาน</Badge>
                    ) : (
                      <Badge variant="destructive">ปิดใช้งาน</Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-right">
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
      </div>

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
    </Section>
  );
}
