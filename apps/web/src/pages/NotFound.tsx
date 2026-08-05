import { ButtonLink } from '../components/common/Button';
import { useLocale } from '../state/localeContext';

export function NotFound() {
  const { t } = useLocale();

  return (
    <main className="container-page py-20">
      {/* `404` is a status code, not a quantity — left as the literal it is rather
          than sent through `f.integer`, which would group it and, in Burmese, rewrite
          it in digits nobody would recognise as an HTTP status. */}
      <p className="numeric text-caption tracking-[0.22em] text-chalk-3 uppercase">404</p>
      <h1 className="mt-3 text-title text-chalk">{t('notFound.title')}</h1>
      <p className="mt-2 text-body text-chalk-2">{t('notFound.body')}</p>
      <div className="mt-6">
        <ButtonLink to="/products">{t('nav.allProducts')}</ButtonLink>
      </div>
    </main>
  );
}
