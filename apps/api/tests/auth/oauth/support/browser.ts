import { FakeProvider } from './fake-provider';

/**
 * Just enough browser to make fix ⓑ testable.
 *
 * The whole of plan 6(b) is about *which browser* completes a callback, so a test that
 * shares one cookie store between the attacker and the victim cannot express the attack at
 * all. A `CookieJar` is therefore a first-class thing here: two jars are two browsers, and
 * the attack test is literally "start the flow in jar A, deliver the callback with jar B".
 *
 * It is deliberately small and deliberately correct about one thing: `Max-Age=0` deletes.
 * Asserting that the state cookie is cleared after a callback is asserting that this jar
 * stops holding it.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(setCookie: readonly string[] | string | undefined): void {
    if (setCookie === undefined) return;
    // Spelled this way rather than with `Array.isArray`, whose narrowing on a `readonly
    // string[] | string` union collapses to `any[]` and takes `noImplicitAny` with it.
    const headers: readonly string[] = typeof setCookie === 'string' ? [setCookie] : setCookie;
    for (const header of headers) {
      const [pair, ...attributes] = header.split(';');
      if (pair === undefined) continue;
      const separator = pair.indexOf('=');
      if (separator < 0) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0');

      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const headersFrom = (jar: CookieJar): Record<string, string> => {
  const cookie = jar.header();
  return cookie === undefined ? {} : { cookie };
};

export interface Redirected {
  readonly status: number;
  readonly location: string;
  readonly setCookie: string[];
}

/** Every response in these flows is a redirect; `redirect: 'manual'` is what lets us read it. */
export async function get(url: string, jar: CookieJar): Promise<Redirected> {
  const response = await fetch(url, { redirect: 'manual', headers: headersFrom(jar) });
  const setCookie = response.headers.getSetCookie();
  jar.store(setCookie);
  return { status: response.status, location: response.headers.get('location') ?? '', setCookie };
}

export async function postForm(
  url: string,
  form: Readonly<Record<string, string>>,
  jar: CookieJar,
): Promise<Redirected> {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...headersFrom(jar), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const setCookie = response.headers.getSetCookie();
  jar.store(setCookie);
  return { status: response.status, location: response.headers.get('location') ?? '', setCookie };
}

/**
 * What the provider hands back: a callback URL for three of them, a form to submit for
 * Apple.
 *
 * Apple's HTML is parsed rather than special-cased into a synthetic POST, because the shape
 * of the round trip — a cross-site form submission — is precisely the thing that forces
 * `SameSite=None` on the state cookie. Reading the fields out of the form the fake rendered
 * keeps the test honest about it.
 */
export type ProviderHandback =
  | { readonly kind: 'redirect'; readonly callbackUrl: string }
  | { readonly kind: 'form'; readonly action: string; readonly fields: Record<string, string> };

export async function authorizeAt(authorizationUrl: string): Promise<ProviderHandback> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });

  if (response.status === 302) {
    const location = response.headers.get('location');
    if (location === null) throw new Error('provider redirected with no Location');
    return { kind: 'redirect', callbackUrl: location };
  }

  const html = await response.text();
  const action = /<form[^>]*action="([^"]*)"/.exec(html)?.[1];
  if (action === undefined) throw new Error(`provider returned no form: ${html.slice(0, 200)}`);

  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]*name="([^"]*)"[^>]*value="([^"]*)"/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) fields[name] = unescapeHtml(value);
  }
  return { kind: 'form', action: unescapeHtml(action), fields };
}

export interface SignInOutcome {
  readonly start: Redirected;
  readonly handback: ProviderHandback;
  readonly callback: Redirected;
}

/**
 * The whole round trip, in the order a browser does it.
 *
 * `startJar` and `callbackJar` are separate parameters and default to the same jar. One jar
 * is an ordinary sign-in; two jars is the ⓑ attack, and having to name the second one makes
 * that difference impossible to write by accident.
 */
export async function signIn(options: {
  readonly apiBaseUrl: string;
  readonly provider: FakeProvider;
  readonly jar: CookieJar;
  readonly callbackJar?: CookieJar;
  readonly returnTo?: string;
  readonly mutateCallback?: (url: URL) => void;
}): Promise<SignInOutcome> {
  const startUrl = new URL(`${options.apiBaseUrl}/auth/oauth/${options.provider.mode}/start`);
  if (options.returnTo !== undefined) startUrl.searchParams.set('returnTo', options.returnTo);

  const start = await get(startUrl.toString(), options.jar);
  const handback = await authorizeAt(start.location);
  const callbackJar = options.callbackJar ?? options.jar;

  if (handback.kind === 'redirect') {
    const url = new URL(handback.callbackUrl);
    options.mutateCallback?.(url);
    return { start, handback, callback: await get(url.toString(), callbackJar) };
  }

  const url = new URL(handback.action);
  options.mutateCallback?.(url);
  return {
    start,
    handback,
    callback: await postForm(url.toString(), handback.fields, callbackJar),
  };
}

function unescapeHtml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}
