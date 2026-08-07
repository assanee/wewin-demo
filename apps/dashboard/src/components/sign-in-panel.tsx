'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiJson } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { PasswordSignInForm } from '@/components/password-sign-in-form';
import { oauthStartUrl, safeReturnTo } from '@/lib/auth/sign-in-url';

/**
 * The sign-in buttons, and only the ones this deployment can actually serve.
 *
 * The list comes from `GET /auth/oauth/providers`, which apps/api derives from the
 * credentials it holds — so a button never leads to the 404 that an unconfigured provider
 * answers with. Hard-coding four buttons and hiding three by hand is exactly what that
 * endpoint exists to prevent, and in this repository it matters more than usual: no real
 * provider credentials exist here, so the honest render of this page today is "no provider
 * is configured".
 *
 * Each button is an `<a href>` to the API's origin, not a `fetch`. See sign-in-url.ts —
 * `start` answers 302 and sets the browser-binding cookie plan 6(b) turns on, and a
 * background fetch would bind the cookie to a navigation the user never makes.
 */

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  line: 'LINE',
  google: 'Google',
  facebook: 'Facebook',
  apple: 'Apple',
};

interface ProvidersBody {
  readonly providers: readonly string[];
}

function decodeProviders(body: unknown): ProvidersBody {
  if (typeof body !== 'object' || body === null || !('providers' in body)) {
    throw new Error('providers: expected { providers: string[] }');
  }
  const { providers } = body as { providers: unknown };
  if (!Array.isArray(providers) || providers.some((name: unknown) => typeof name !== 'string')) {
    throw new Error('providers: expected an array of strings');
  }
  return { providers: providers as readonly string[] };
}

type ProvidersState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly providers: readonly string[] }
  | { readonly status: 'failed'; readonly message: string };

/** The two reasons apps/api will ever give, and they are deliberately only two. */
const FAILURE_COPY: Readonly<Record<string, string>> = {
  denied: 'คุณยกเลิกการเข้าสู่ระบบ ลองใหม่ได้เมื่อพร้อม',
  failed: 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หากยังไม่ได้โปรดติดต่อผู้ดูแลระบบ',
};

export function SignInPanel() {
  const search = useSearchParams();
  const router = useRouter();
  const { state } = useSession();
  const [providers, setProviders] = useState<ProvidersState>({ status: 'loading' });

  const returnTo = safeReturnTo(search.get('next'));
  const error = search.get('error');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        /*
         * `anonymous` — there is no session yet by definition, and a 401 here would mean the
         * endpoint is broken rather than the token is stale. Attaching a token and retrying
         * behind a 401 would turn a misconfigured API into a silent double request.
         */
        const body = await apiJson('/auth/oauth/providers', decodeProviders, { anonymous: true });
        if (!cancelled) setProviders({ status: 'ready', providers: body.providers });
      } catch (cause) {
        if (cancelled) return;
        setProviders({
          status: 'failed',
          message:
            cause instanceof ApiError
              ? cause.message
              : 'ไม่สามารถอ่านรายการช่องทางเข้าสู่ระบบจาก API ได้',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    /*
     * Somebody who is already signed in and lands here — a bookmark, a Back button after
     * signing in — should not be shown a login form. `replace` so Back does not return to
     * the form they were bounced off.
     */
    if (state.status === 'signed-in') router.replace(returnTo);
  }, [state.status, router, returnTo]);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>เข้าสู่ระบบ</CardTitle>
        <CardDescription>ระบบจัดการภายในของ WEWIN สำหรับพนักงานเท่านั้น</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error !== null && (
          <Alert variant="destructive">
            <AlertTitle>เข้าสู่ระบบไม่สำเร็จ</AlertTitle>
            <AlertDescription>{FAILURE_COPY[error] ?? FAILURE_COPY['failed']}</AlertDescription>
          </Alert>
        )}

        {providers.status === 'loading' && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {providers.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>ติดต่อ API ไม่ได้</AlertTitle>
            <AlertDescription>{providers.message}</AlertDescription>
          </Alert>
        )}

        {/*
          The password form is first and is always shown. It does not depend on
          `GET /auth/oauth/providers`, which is the whole reason it exists: before it, an API
          with no provider configured had no way in at all, and a fresh checkout meant
          registering a real OAuth application with Google to look at the dashboard.
          Rendering it above the buttons also matches what staff will use daily.
        */}
        <PasswordSignInForm />

        {providers.status === 'ready' && providers.providers.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            หรือ
            <span className="h-px flex-1 bg-border" />
          </div>
        )}

        {providers.status === 'ready' &&
          (providers.providers.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              {providers.providers.map((provider) => (
                <Button key={provider} asChild variant="outline" className="w-full">
                  {/*
                    A plain anchor and not `next/link`: this leaves the app for the API's
                    origin, and the client-side router has nothing useful to do with that.
                  */}
                  <a href={oauthStartUrl(provider, returnTo)}>
                    เข้าสู่ระบบด้วย {PROVIDER_LABELS[provider] ?? provider}
                  </a>
                </Button>
              ))}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
