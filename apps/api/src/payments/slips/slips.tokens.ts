/**
 * Injection tokens for this module's configuration.
 *
 * Its own file so that `slip-storage.ts` and `slips.module.ts` can both name the token
 * without either importing the other's module — the same shape `src/media/media.tokens.ts`
 * uses, and for the same reason: a token defined in the module file makes every consumer
 * import the module, which is a cycle waiting for the first provider that needs one.
 */
export const SLIP_STORAGE_CONFIG = Symbol('wewin.payments.slips.storageConfig');
