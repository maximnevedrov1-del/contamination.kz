/**
 * SaudaPulse — features that are switched off in the release build.
 *
 * cabinet: work through an open Kaspi seller-cabinet tab (reading pages, customer chat).
 *   Needs the real markup of the cabinet (TODO selectors in shared/selectors.js), which
 *   has not been checked on a live store yet. While it is off:
 *     - no content scripts are shipped (nothing runs on kaspi.kz pages);
 *     - an open cabinet tab never creates a store (it would count toward the plan);
 *     - «Чат» is hidden; stores work through the official API token only.
 *   Development builds and the test suites keep it on (demo cabinet pages).
 *   tools/build-release.mjs sets it to false unless run with --with-cabinet.
 */
export const FEATURES = Object.freeze({
  cabinet: true,
});
