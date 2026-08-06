/**
 * What the rest of the process may import from the profile round.
 *
 * The module, its wire types, and the effects table — and deliberately **not** the service or
 * the repository. A feature that wants somebody's stored locale should reach the column
 * through its own query (see the note in `profile.module.ts` on why the notification worker
 * joins rather than injects), and a feature that wants to *write* one is a feature that has
 * misunderstood whose preference it is.
 *
 * `PREFERENCE_EFFECTS` is exported because it is the honest answer to "does this setting do
 * anything", and the day a `false` becomes a `true` the change belongs in one file that a
 * reviewer can read whole.
 */

export { ProfileModule } from './profile.module';

export { PREFERENCE_EFFECTS, preferenceIsHonoured } from './preference-effects';

export {
  PREFERENCE_KINDS,
  PREFERENCE_SURFACES,
  preferencesRequestSchema,
  type MessageLocaleWire,
  type PreferenceEffectWire,
  type PreferenceKind,
  type PreferenceSurface,
  type PreferencesRequest,
  type PreferencesResponseWire,
  type PreferencesWire,
} from './profile.contract';
