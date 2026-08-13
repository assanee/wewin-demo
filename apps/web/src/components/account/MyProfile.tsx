'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { fetchProfile, type PhoneProof, type ProfileDetails } from '../../lib/auth/profile';
import type { Session } from '../../lib/auth/account';
import { localeHref } from '../../lib/routing';
import { useLocale } from '../../state/localeContext';
import type { PlainKey } from '../../i18n/keys';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ ข้อมูลผู้ใช้งาน — WHAT WE HOLD ABOUT YOU, AND HOW SURE WE ARE OF IT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The third tab of the account page. Name, telephone, email — and, for each number, whether
 * anybody actually proved it and who.
 *
 * ── ⚠️ READ-ONLY, AND THAT IS THE DECISION RATHER THAN THE SHORTFALL ─────────
 *
 * The task asked for the cheaper honest thing first, and this is it. **The API has no route by
 * which a customer may rewrite any of these three fields**, and the three would not be one
 * feature if it did:
 *
 *   **The name** is the only genuinely easy one. `users.display_name` is nullable and `UPDATE`-able
 *   — `erase_user()` nulls it that way — so a `PUT /me/account/profile` taking a display name is
 *   a small controller, a Zod shape, a route-audit line and a decision about what a customer may
 *   call themselves on documents staff read. Not free, but ordinary work.
 *
 *   **The email** cannot be a text field at all. Writing to `user_emails` is writing an identity:
 *   a verified address is a way to sign in and the target of a password reset, and
 *   `user_emails_claim_guard` refuses an address another account has proved. Letting a customer
 *   type one would need the verification round trip this system does not have — and until it does,
 *   an address they typed would be an unverified claim that this very tab would (correctly) refuse
 *   to show them, which is a form whose only visible effect is nothing.
 *
 *   **The number** is worse, because it is *the* credential here: every account on this storefront
 *   signs in with a telephone number. `user_phones_verification_is_final` refuses changing a
 *   verified number, `UNIQUE(number)` refuses claiming one that is taken, and an editable number
 *   with no OTP is an account-takeover surface — the same fork `ChangePassword`'s header leaves
 *   open for the forgotten-password case.
 *
 * So an edit form here would have had one field that works and two that either fail silently or
 * open a hole. A screen that shows the truth and says where a correction comes from is worth
 * shipping; that is `account.profile.readOnly`, and it is rendered unconditionally rather than
 * only when there is something to correct.
 *
 * ── The preferred language is not here, on purpose ───────────────────────────
 *
 * `/[locale]/settings` already owns it, reads and writes `GET/PUT /me/preferences`, and applies
 * the choice through the same cookie the header's picker writes. Two controls over one stored
 * value disagree the moment either is used. The tab links to the settings page instead — which
 * also fixes a real gap, since nothing on the account page mentioned that the page exists.
 *
 * ── Why the fetch is a `useEffect` on mount, like `MyQuotations` ─────────────
 *
 * ⚠️ **All three panels render on every visit** — `AccountScreen` renders each one with `hidden`
 * on the ones not showing, because rendering only the selected panel left the unselected tabs'
 * `aria-controls` pointing at nothing. So this component mounts and fetches even for a customer
 * who came to pay, and the account page now costs `GET /orders?limit=50` **and**
 * `GET /me/account` on every visit rather than one of them.
 *
 * That is a real cost and it is the same trade the password tab's arrival already made and
 * argued. It is also smaller than it looks: `prefillContact.ts` was already calling
 * `GET /me/account` on the quotation form, so this is a request the storefront makes anyway, and
 * it is `no-store` at both ends because it carries somebody's name and number.
 */

/**
 * The three verification states, each with the sentence that describes it.
 *
 * A `Record` over the union rather than a chain of ternaries, the same idiom `ChangePassword`
 * uses for its problem codes: a fourth state added to `PhoneProof` is a compile error here, which
 * is what stops it silently rendering as the first branch of an `if`.
 */
const PROOF_KEYS: Readonly<Record<PhoneProof, PlainKey>> = {
  verified: 'account.profile.verified',
  'verified-by-staff': 'account.profile.verifiedByStaff',
  unverified: 'account.profile.unverified',
};

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly details: ProfileDetails };

export function MyProfile({ session }: { readonly session: Session }): ReactElement {
  const { t, locale } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void fetchProfile(session.accessToken).then((details) => {
      if (cancelled) return;
      setPhase(details === null ? { kind: 'failed' } : { kind: 'ready', details });
    });

    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  if (phase.kind === 'loading') {
    return <p className="text-small text-chalk-2">{t('account.checking')}</p>;
  }

  /*
   * ⚠️ One sentence for every failure, including the refusal a closed or erased account gets.
   *
   * A tombstone must not render a profile as though the person were still there, and the reason
   * it cannot is not a branch here: `accountUsability` refuses every non-`active` status on every
   * guarded route ahead of permissions, so `GET /me/account` answers a refusal and this lands in
   * exactly the same place as an unreachable network. Nothing partial is ever drawn — there is no
   * code path in this component that renders a field from an unsuccessful read.
   */
  if (phase.kind === 'failed') {
    return <p className="text-small text-chalk-2">{t('account.problem.unreachable')}</p>;
  }

  const { name, phones, emails } = phase.details;
  const anyUnverified = phones.some((phone) => phone.proof === 'unverified');

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-3">
        {/*
          ⚠️ A `<dl>` and not a table or a stack of `<p>`s. These are label/value pairs, which is
          what a description list is for and what lets a screen reader read "Name, no name on
          file" as one unit. No `<h2>` above it: `AccountScreen`'s header explains that the tab
          *is* the section's name — it is what `aria-labelledby` points this panel at — so a
          heading repeating "ข้อมูลผู้ใช้งาน" would be a duplicate to a screen reader.
        */}
        <Row label={t('account.profile.name')}>
          {name === null ? (
            /*
             * The ordinary state, not an error, and styled as one. Registration here is a
             * telephone number and a password; nothing in that flow ever sets a display name, so
             * almost every customer reads this line. `text-chalk-3` rather than `text-danger`.
             */
            <span className="text-body text-chalk-3">{t('account.profile.nameUnset')}</span>
          ) : (
            <span className="text-body text-chalk">{name}</span>
          )}
        </Row>

        <Row label={t('account.phone')}>
          {phones.length === 0 ? (
            <span className="text-body text-chalk-3">{t('account.profile.noPhone')}</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {phones.map((phone) => (
                <li key={phone.number} className="flex flex-wrap items-baseline gap-2">
                  {/* `numeric` for the same reason every other figure in this app has it. */}
                  <span className="numeric text-body text-chalk">{phone.number}</span>
                  {/*
                    ⚠️ The state is a word, never a colour or a tick on its own. A green dot beside
                    a number says nothing to somebody who cannot separate the two greens this
                    palette uses, and `settings`' own two-tick control was the bug that taught this
                    codebase the lesson. `text-chalk-3` on the unverified one is emphasis, not the
                    message.
                  */}
                  <span
                    className={`text-caption ${
                      phone.proof === 'unverified' ? 'text-chalk-3' : 'text-lime'
                    }`}
                  >
                    {t(PROOF_KEYS[phone.proof])}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Row>

        <Row label={t('account.profile.email')}>
          {emails.length === 0 ? (
            /*
             * ⚠️ "ยังไม่มีอีเมล**ที่ยืนยันแล้ว**". `GET /me/account` returns verified addresses
             * only — load-bearingly, since `waysIn` counts that list — so a bare "you have no
             * email" would be false for somebody holding an unverified claim, and this is the
             * screen where that person would read it.
             */
            <span className="text-body text-chalk-3">{t('account.profile.noEmail')}</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {emails.map((address) => (
                <li key={address} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-body text-chalk">{address}</span>
                  {/*
                    Every address here is proved by construction, so the word is unconditional
                    rather than derived from a field. Said out loud anyway: this list and the
                    numbers above it look alike and mean different things.
                  */}
                  <span className="text-caption text-lime">{t('account.profile.verified')}</span>
                </li>
              ))}
            </ul>
          )}
        </Row>
      </dl>

      {/*
        ⭐ Shown only when there is an unverified number to explain, and it does not ask the
        reader for anything.

        There is no self-service verification on this storefront — no SMS budget, no OTP route —
        so a note saying "confirm your number" beside a button that does not exist would be worse
        than silence. This says a member of staff does it on the telephone, which is true and is
        the whole of what the customer can expect.
      */}
      {anyUnverified ? (
        <p className="border border-line bg-panel-2 p-3 text-caption text-chalk-2">
          {t('account.profile.unverifiedNote')}
        </p>
      ) : null}

      {/*
        Unconditional, because "you cannot change this here" is true whether or not anything on
        the screen looks wrong, and a customer who spots a wrong number needs the sentence at the
        moment they spot it rather than after asking.
      */}
      <p className="text-caption text-chalk-3">{t('account.profile.readOnly')}</p>

      {/*
        The language, named rather than duplicated — see the header. A link, so the sentence is
        actionable; `localeHref` because every path in this app carries the locale as its first
        segment.
      */}
      <a className="w-fit text-caption text-chalk-2 underline" href={localeHref(locale, '/settings')}>
        {t('account.profile.languageElsewhere')}
      </a>
    </div>
  );
}

/** One `dt`/`dd` pair. A component so the three rows cannot drift apart in markup or spacing. */
function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1 border-b border-line pb-2">
      <dt className="text-caption text-chalk-2">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}
