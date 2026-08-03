import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/*
 * A WeakMap rather than `req.requestId`: augmenting Express's Request interface globally
 * would leak this app's shape into every file that imports express types, and casting to
 * reach a bolted-on property is the kind of `any` this repo does not allow.
 */
const requestIds = new WeakMap<object, string>();

/** Reject junk from the edge — an id is echoed into logs and must stay greppable. */
const SAFE_ID = /^[\w.:-]{1,128}$/;

export function getRequestId(request: object): string {
  return requestIds.get(request) ?? 'unknown';
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const id = candidate !== undefined && SAFE_ID.test(candidate) ? candidate : randomUUID();

    requestIds.set(request, id);
    response.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
