import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { AppError } from './errors/app-error';

/**
 * The one key `z.strictObject` cannot see, refused before any schema runs.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────
 *
 * `src/orders/transitions.ts` sells strictness as the second of three defences against plan
 * 7.4 trap 4, in these words: *"`z.strictObject` refuses an unknown key rather than dropping
 * it, which converts the trap's silent strip into a 400 the caller can read."* That is true
 * of every key but one.
 *
 *     {"reason":"ok","surprise":1}                                  → 400
 *     {"reason":"ok","__proto__":{"attributeFaultToCompany":true}}  → 200
 *
 * `JSON.parse` writes `__proto__` as an ordinary own data property — it does *not* set the
 * prototype, so nothing is polluted and no field is smuggled into the parsed body — but the
 * unknown key is dropped in silence, which is precisely the behaviour the comment promises
 * cannot happen. There is no escalation today because the third defence holds (`faultFor`
 * refuses a non-staff actor before it reads any flag, and the database checks
 * `required_payload_keys` on the insert). A defence whose stated mechanism does not work,
 * standing in front of two that do, is worse than an absent one: the next person reads the
 * comment and relies on it.
 *
 * ── Why here rather than in the schemas ──────────────────────────────────────────
 *
 * Because the schemas are chosen *late* on purpose. The transition body deliberately reaches
 * the service as `unknown` so that the payload kind can be read from the locked row (trap 4),
 * so there is no single pipe every body passes through — and a rule enforced in some parsers
 * is a rule with a hole shaped like whichever one is added next. Middleware runs after
 * body-parser and before every guard, controller and pipe in the process, which makes this
 * the one place that sees every parsed body exactly once.
 *
 * ── What it refuses, and what it deliberately does not ───────────────────────────
 *
 * `__proto__` only. `constructor` and `prototype` are ordinary words that a future payload
 * may legitimately carry as data, and refusing them would be a rule people work around; the
 * defect that was actually demonstrated is this key, and it is a key no honest client sends.
 * The whole body is walked, because a nested object is exactly where it would be hidden.
 */
@Injectable()
export class JsonBodyMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    if (containsProtoKey(request.body, 0)) {
      throw AppError.badRequest('รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง', { key: '__proto__' });
    }
    next();
  }
}

/**
 * Depth-limited: a body-parser limit bounds the *bytes*, not the nesting, and an unbounded
 * recursive walk over a deliberately deep document is a stack overflow any client can send.
 * Past the limit the answer is the same refusal — a body nested more than thirty deep is not
 * one of ours either.
 */
const MAX_DEPTH = 30;

function containsProtoKey(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (depth > MAX_DEPTH) return true;

  if (Array.isArray(value)) {
    return value.some((item) => containsProtoKey(item, depth + 1));
  }

  // `Object.keys` and not `in`: the own data property is what JSON.parse produced, and the
  // inherited accessor of the same name is on every object in the process.
  for (const key of Object.keys(value)) {
    if (key === '__proto__') return true;
    if (containsProtoKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }

  return false;
}
