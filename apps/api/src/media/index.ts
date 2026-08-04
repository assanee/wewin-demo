/**
 * What the rest of the app may import from the media feature.
 *
 * Which is: the module, and the wire types. Everything else — the object store, the image
 * readers, the repository — is behind it on purpose. A second thing writing to
 * `media_objects` would be a second thing deciding what a storage key means, and the content
 * addressing only holds because exactly one thing decides.
 */

export { MediaModule, type MediaModuleOptions } from './media.module';
export { parseMediaConfig, MediaConfigError, type MediaConfig } from './media.config';
export type {
  MediaListWire,
  MediaObjectWire,
  MediaReferenceWire,
  MediaUploadResultWire,
  MediaUsageWire,
} from './media.contract';
