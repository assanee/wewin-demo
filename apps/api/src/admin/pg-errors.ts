import { AppError } from '../common/errors/app-error';

/**
 * The constraints in `packages/db`, translated into answers a dashboard can act on.
 *
 * Every rule this module could restate in TypeScript is already a `UNIQUE`, a `CHECK` or a
 * trigger, and plan 5 point 3 is explicit that the cross-row ones *have* to live there —
 * a zod schema cannot see whether another product already claims a slug. The consequence
 * is that the honest failure for "this slug is taken" arrives as a driver error, and the
 * choice is between guessing ahead of the write with a SELECT that races, or reading the
 * error the database actually returned.
 *
 * This reads the error. What it deliberately does not do is forward the driver's own
 * message: `detail` on a unique violation contains the conflicting row's values, which for
 * `users` would be an email address and for anything else is still a column dump in a
 * response body. The constraint *name* is enough to say which rule was broken, and the
 * names in `src/schema` were chosen to be readable for exactly this reason.
 */

interface PostgresErrorLike {
  readonly code: string;
  readonly constraint: string | undefined;
}

/** SQLSTATEs this module knows how to explain. Anything else stays a 500 with a stack. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
/** What `RAISE ... USING ERRCODE = 'restrict_violation'` produces — the freeze triggers. */
const RESTRICT_VIOLATION = '23001';

/**
 * Find the driver error, however deeply it has been wrapped.
 *
 * Drizzle rethrows a query failure as `DrizzleQueryError`, which carries no `code` of its
 * own and keeps the real one on `.cause`. Reading `error.code` off the top therefore sees
 * `undefined` for every CHECK, UNIQUE and FK the catalogue relies on, and each of them
 * reaches the caller as an untranslated 500 — the constraint fires, the database is
 * protected, and the client is told nothing it can act on.
 *
 * Walking the chain rather than reaching for `.cause` once, because a wrapper is free to
 * add another layer and this is not worth revisiting when it does.
 */
function postgresErrorOf(error: unknown): PostgresErrorLike | undefined {
  for (let current: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;

    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') {
        const constraint =
          'constraint' in current ? (current as { constraint: unknown }).constraint : undefined;
        return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
      }
    }

    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return undefined;
}

/** Thai for the constraints an editor can actually do something about. */
const EXPLANATIONS: ReadonlyMap<string, string> = new Map([
  ['products_slug_unique', 'มีสินค้าที่ใช้ slug นี้อยู่แล้ว'],
  ['products_sku_prefix_unique', 'มีสินค้าที่ใช้รหัสนำหน้า SKU นี้อยู่แล้ว'],
  ['products_pkey', 'มีสินค้ารหัสนี้อยู่แล้ว'],
  ['products_price_whole_baht', 'ราคาต่อตารางเมตรต้องเป็นจำนวนบาทเต็ม'],
  ['products_price_positive', 'ราคาต่อตารางเมตรต้องมากกว่าศูนย์'],
  ['products_lead_time_ordered', 'ระยะเวลาผลิตขั้นต่ำต้องไม่มากกว่าขั้นสูง'],
  ['products_min_billable_positive', 'พื้นที่คิดเงินขั้นต่ำต้องมากกว่าศูนย์'],
  ['option_groups_code_unique', 'มีกลุ่มตัวเลือกรหัสนี้อยู่แล้ว'],
  ['option_groups_sku_shape', 'กลุ่มแบบ sku ต้องใช้ input เป็น swatch, chip หรือ toggle และไม่มีหน่วยวัด'],
  ['option_groups_custom_shape', 'กลุ่มแบบวัดขนาดต้องใช้ input เป็น number และต้องระบุหน่วยที่ใช้เขียน'],
  ['option_values_group_code_key', 'มีตัวเลือกรหัสนี้ในกลุ่มนี้อยู่แล้ว'],
  ['option_values_delta_shape', 'ค่าส่วนเพิ่มไม่ตรงกับชนิดที่เลือก'],
  ['option_values_delta_whole_units', 'ส่วนเพิ่มต้องเป็นจำนวนบาทเต็มหรือเปอร์เซ็นต์เต็ม'],
  ['option_values_swatch_hex_format', 'รหัสสีต้องอยู่ในรูปแบบ #RRGGBB'],
  ['product_version_options_grid', 'ช่วงขนาดไม่ลงตัวกับสเต็ป — สเต็ปต้องเป็นจำนวนเท่าของ 25 µm และ min/max/default ต้องอยู่บนกริดเดียวกัน'],
  ['product_version_options_sku_shape', 'กลุ่มแบบ sku ต้องมีค่าเริ่มต้นและต้องไม่มีช่วงขนาด'],
  ['product_version_options_custom_shape', 'กลุ่มแบบวัดขนาดต้องมีช่วงขนาดครบและต้องไม่มีค่าเริ่มต้นแบบ sku'],
  ['product_version_rules_version_code_key', 'มีกฎรหัสนี้ในร่างนี้อยู่แล้ว'],
  ['product_versions_one_published_per_product', 'สินค้านี้มีเวอร์ชันที่เผยแพร่อยู่แล้ว'],
  ['product_versions_product_version_key', 'เลขเวอร์ชันนี้ถูกใช้ไปแล้ว'],
]);

/**
 * Turn a driver error into an `AppError`, or hand it back untouched.
 *
 * Rethrowing the original for anything unrecognised is deliberate: an unknown SQLSTATE is
 * a bug in this service, and `AllExceptionsFilter` logs it with a stack and tells the
 * client only the request id. Wrapping it in a 4xx here would file our bug under the
 * caller's mistakes and lose the stack on the way.
 */
export function translatePostgresError(error: unknown): unknown {
  const pg = postgresErrorOf(error);
  if (!pg) return error;

  const named = pg.constraint;
  const explained = named === undefined ? undefined : EXPLANATIONS.get(named);
  const details = named === undefined ? undefined : { constraint: named };

  switch (pg.code) {
    case UNIQUE_VIOLATION:
      return AppError.conflict(explained ?? 'ข้อมูลนี้ซ้ำกับที่มีอยู่แล้ว', details);

    case FOREIGN_KEY_VIOLATION:
      // 422 and not 404: the request named something that does not exist, but *which*
      // something is the reference and not the resource the request was addressed to.
      return AppError.validationFailed(explained ?? 'อ้างถึงข้อมูลที่ไม่มีอยู่', details);

    case CHECK_VIOLATION:
      return AppError.validationFailed(explained ?? 'ข้อมูลไม่ผ่านเงื่อนไขของแคตตาล็อก', details);

    case RESTRICT_VIOLATION:
      /*
       * A freeze trigger fired. Reaching this means something tried to edit a published or
       * archived version, which every path in this module is written not to do — so it is
       * a 409 with the plain reason rather than a translated one, and the message from
       * `0001_catalog_freeze.sql` names the version and its status.
       */
      return AppError.conflict(
        'เวอร์ชันนี้ถูกเผยแพร่แล้วและแก้ไขไม่ได้ — สร้างร่างใหม่แทน',
        { reason: 'frozen' },
      );

    default:
      return error;
  }
}

/** `await withTranslatedErrors(() => tx.insert(...))` — one wrapper per write path. */
export async function withTranslatedErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translatePostgresError(error);
  }
}
