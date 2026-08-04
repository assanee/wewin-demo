import type { Request } from 'express';

import { AppError } from '../common/errors/app-error';

/**
 * Read the request body into memory, and stop reading the moment it is too big.
 *
 * Three things here are the difference between an upload endpoint and a hole in the wall.
 *
 * **The limit is counted, not believed.** `Content-Length` is a number the client typed. A
 * chunked upload does not send one at all, and one that does can lie. So the bytes are
 * counted as they arrive and the connection is destroyed the instant the count passes the
 * ceiling — which means the ceiling is a bound on memory, not merely a policy that is
 * checked afterwards. The header is still consulted first, purely to fail fast and cheaply
 * on the honest client that is about to send 400 MB.
 *
 * **The socket is destroyed, not just abandoned.** Responding 413 while the client is still
 * sending leaves the sender writing into a connection nobody is reading, and Node buffers
 * it. `destroy()` is what makes the refusal cost the server nothing.
 *
 * **No multipart parser.** The body *is* the file — the dashboard sends the raw `File` as
 * the request body — so there is no `multipart/form-data` boundary to parse, no filename
 * field inside it, and no second parser between the network and the image. The filename is
 * a header, and the module comment in image/index.ts explains why nothing is decided from
 * it anyway.
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) {
    throw tooLarge(maxBytes);
  }

  const chunks: Buffer[] = [];
  let received = 0;

  return new Promise<Buffer>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        cleanUp();
        request.destroy();
        reject(tooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      cleanUp();
      if (received === 0) {
        reject(AppError.badRequest('ไม่มีข้อมูลไฟล์ในคำขอ — กรุณาแนบไฟล์รูปมาด้วย'));
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    const onError = (cause: Error): void => {
      cleanUp();
      // A client that hung up mid-upload is not a server fault; it is a 400 with the
      // network's own message, and never a 500 that pages somebody.
      reject(AppError.badRequest(`การอัปโหลดถูกตัดกลางคัน (${cause.message})`));
    };

    const cleanUp = (): void => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
    };

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

function tooLarge(maxBytes: number): AppError {
  const megabytes = (maxBytes / (1024 * 1024)).toFixed(1);
  return new AppError(
    'PAYLOAD_TOO_LARGE',
    413,
    `ไฟล์ใหญ่เกิน ${megabytes} MB กรุณาย่อรูปก่อนอัปโหลด`,
    { maxBytes },
  );
}
