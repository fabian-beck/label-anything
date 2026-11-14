/**
 * Compile-time checks, nothing at run time: this package has the API of
 * `@label-anything/core`, and a `PlaceError` of the same shape. A mismatch fails the build.
 */
import type { Issue, LabelAnythingApi, PlaceError as CorePlaceError } from "@label-anything/core";
import type { place, renderDebugSvg, validate, VERSION } from "./api.js";
import type { PlaceError } from "./place-error.js";

type Implements<T extends LabelAnythingApi> = T;
export type ApiCheck = Implements<{
  place: typeof place;
  validate: typeof validate;
  renderDebugSvg: typeof renderDebugSvg;
  VERSION: typeof VERSION;
}>;

type Assignable<A, B extends A> = B;
export type PlaceErrorCheck = [
  Assignable<CorePlaceError, PlaceError>,
  Assignable<PlaceError, CorePlaceError>,
  Assignable<new (errors: Issue[]) => CorePlaceError, typeof PlaceError>,
];
