import type { Formatters } from '../format';
import type { ServerMessage, ServerMessageKey } from '../message';

type ParamsFor<K extends ServerMessageKey> = Extract<ServerMessage, { key: K }>['params'];

/**
 * One catalogue entry.
 *
 * A **string** when the key takes no params, a **function** when it does — and the
 * conditional is the load-bearing part. A parametric key whose entry were allowed to be a
 * plain string would compile, render, and silently drop every number in the sentence; the
 * refusal is what makes "this translation is missing an interpolation" a build failure
 * instead of a customer's screenshot.
 *
 * `[keyof P] extends [never]` rather than `keyof P extends never`, because the naked form
 * distributes over a union and answers `boolean` for a key with two params.
 */
export type CatalogueEntry<K extends ServerMessageKey> = [keyof ParamsFor<K>] extends [never]
  ? string
  : (params: ParamsFor<K>, fmt: Formatters) => string;

/**
 * A complete catalogue — every key, no exceptions.
 *
 * Only Thai is required to satisfy this. It is the source language and the fallback, so a
 * missing Thai entry is a message that renders as nothing in all eight.
 */
export type Catalogue = { readonly [K in ServerMessageKey]: CatalogueEntry<K> };

/**
 * A catalogue that is honestly incomplete.
 *
 * Plan 13 names translation as a human bottleneck, not a code task, and the design decision
 * this type encodes is that an unfinished language is a *first-class state* rather than an
 * error. A German catalogue with nine of a hundred entries is a real German catalogue: those
 * nine render in German and the rest degrade to Thai, visibly, with `degraded: true` on the
 * way out. The alternative — hold every language back until one is complete — means the
 * first ninety-one translations sit finished and unused.
 */
export type PartialCatalogue = { readonly [K in ServerMessageKey]?: CatalogueEntry<K> };

/**
 * An entry whose key is not known statically — what a lookup returns.
 *
 * `CatalogueEntry<ServerMessageKey>` looks like it should be this and is not:
 * `[keyof ParamsFor<K>] extends [never]` puts `K` inside a tuple, which suppresses
 * distribution over the union, so the whole union of keys collapses to `string` and every
 * parametric entry silently fails to type. Spelled out here instead, once, where the
 * reason can be written down next to it.
 */
export type AnyCatalogueEntry = string | ((params: never, fmt: Formatters) => string);
