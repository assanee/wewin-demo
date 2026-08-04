import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '@wewin/contract/version';

import { ZodBodyPipe } from '../admin/zod-body.pipe';
import { AppError } from '../common/errors/app-error';
import { CurrentScope, RequirePermissions, type Scope } from '../rbac';
import {
  mediaListQuerySchema,
  updateMediaRequestSchema,
  type MediaListQuery,
  type MediaListWire,
  type MediaObjectWire,
  type MediaUploadResultWire,
  type UpdateMediaRequestWire,
} from './media.contract';
import { MediaService } from './media.service';
import { readBoundedBody } from './read-body';

/**
 * The dashboard's image library.
 *
 *     GET    /admin/media            what has been uploaded, newest first, with usage
 *     POST   /admin/media            the raw bytes of one image
 *     GET    /admin/media/:id        one image and everything that references it
 *     PATCH  /admin/media/:id        alt text — the only editable field
 *     DELETE /admin/media/:id        refused when a published version names it
 *
 * ── Permissions ───────────────────────────────────────────────────────────────
 *
 * `catalog.read` to look, `catalog.write` to upload, edit or delete. **There is no
 * `media.*` permission and there should be**, which is a decision this round did not get to
 * make: `src/rbac/permissions.ts` is the permission catalogue for the whole application and
 * is outside what this round owns. The reuse is defensible rather than merely convenient —
 * an image exists to be attached to a catalogue entry, and anybody who can change what a
 * product shows can already change everything else about it — but the honest split is
 * `media.write`, because uploading a file is a different risk from editing a price.
 *
 * ── Why the body is the file ──────────────────────────────────────────────────
 *
 * `POST /admin/media` takes the image bytes as the request body, not as a
 * `multipart/form-data` part. That removes a parser from the path between the network and
 * the image — one whose job is to find a filename and a content type inside the body, both
 * of which this API refuses to believe anyway (image/index.ts). The filename rides along in
 * a header, purely so a person recognises their own upload in a grid.
 */

const contractVersion = (): MethodDecorator => Header(CONTRACT_VERSION_HEADER, String(CONTRACT_VERSION));

/**
 * What a client may claim it is sending.
 *
 * A hint check and **not** the security check — the bytes decide, in image/index.ts, and a
 * file announcing `image/png` while being a JPEG is stored correctly as a JPEG. This exists
 * for a different reason: Express's JSON body parser consumes bodies whose content type it
 * recognises, so a request labelled `application/json` would arrive here already drained.
 * Refusing the label up front turns that into a message instead of an empty upload.
 */
const ACCEPTED_REQUEST_TYPES = ['image/', 'application/octet-stream'];

@Controller('admin/media')
export class MediaAdminController {
  constructor(private readonly media: MediaService) {}

  @Get()
  @contractVersion()
  @RequirePermissions('catalog.read')
  async list(
    @Query(new ZodBodyPipe(mediaListQuerySchema)) query: MediaListQuery,
  ): Promise<MediaListWire> {
    return this.media.list(query.limit, query.cursor === undefined ? undefined : new Date(query.cursor));
  }

  @Post()
  @contractVersion()
  @RequirePermissions('catalog.write')
  /*
   * 201 for a new object, 200 when these exact bytes were already stored — hence
   * `passthrough`, which lets the handler set a status and still return a body Nest
   * serialises. The distinction is real to the caller: on 200 the row it gets back belongs
   * to whoever uploaded the file first, alt text and all.
   */
  async upload(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CurrentScope() scope: Scope,
  ): Promise<MediaUploadResultWire> {
    requireImageContentType(request);

    const bytes = await readBoundedBody(request, this.media.maxBytes);
    const result = await this.media.upload(bytes, filenameHeader(request), { userId: userIdOf(scope) });

    response.status(result.deduplicated ? 200 : 201);
    return result;
  }

  @Get(':mediaId')
  @contractVersion()
  @RequirePermissions('catalog.read')
  async get(@Param('mediaId') mediaId: string): Promise<MediaObjectWire> {
    return this.media.get(mediaId);
  }

  @Patch(':mediaId')
  @contractVersion()
  @RequirePermissions('catalog.write')
  async update(
    @Param('mediaId') mediaId: string,
    @Body(new ZodBodyPipe(updateMediaRequestSchema)) request: UpdateMediaRequestWire,
  ): Promise<MediaObjectWire> {
    return this.media.setAltText(mediaId, request.altTextTh);
  }

  @Delete(':mediaId')
  @contractVersion()
  @HttpCode(204)
  @RequirePermissions('catalog.write')
  async remove(@Param('mediaId') mediaId: string): Promise<void> {
    return this.media.delete(mediaId);
  }
}

/**
 * The scope on a permission-guarded route is always a user — the guard refuses anything else
 * before the handler runs. This is the assertion of that, not a check that could fail in
 * practice: `uploaded_by_user_id` is the only record of who put a file on a public URL, and
 * a `null` there because somebody widened the decorator later is worth failing loudly over.
 */
function userIdOf(scope: Scope): string {
  if (scope.kind !== 'user') {
    throw AppError.unauthenticated('การอัปโหลดต้องทำในนามผู้ใช้ที่ลงชื่อเข้าใช้แล้ว');
  }
  return scope.userId;
}

function requireImageContentType(request: Request): void {
  const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ACCEPTED_REQUEST_TYPES.some((accepted) => declared.startsWith(accepted))) {
    throw AppError.badRequest(
      'ต้องส่งไฟล์รูปเป็นเนื้อหาของคำขอโดยตรง พร้อมระบุ Content-Type เป็น image/* หรือ application/octet-stream',
      { received: declared },
    );
  }
}

/**
 * `X-Upload-Filename`, if it is there and is a header value rather than an attack.
 *
 * Headers are latin-1 on the wire, so a Thai filename has to be encoded to survive the trip;
 * the dashboard sends it percent-encoded and this decodes it. A malformed encoding is
 * dropped rather than rejected — the filename is decoration, and failing an upload over one
 * would be the tail wagging the dog.
 */
function filenameHeader(request: Request): string | undefined {
  const raw = request.headers['x-upload-filename'];
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
