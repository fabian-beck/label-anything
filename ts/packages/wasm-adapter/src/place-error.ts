import type { Issue } from "@label-anything/core";

/**
 * Thrown by `place` when the problem is invalid or cannot be prepared.
 *
 * The same class as `PlaceError` of `@label-anything/core` (identical shape, name and
 * message), defined here because the runtime code of this package never imports the
 * TypeScript implementation. `instanceof` therefore distinguishes the two classes; test
 * `error.name === "PlaceError"` to accept both.
 */
export class PlaceError extends Error {
  readonly errors: Issue[];
  constructor(errors: Issue[]) {
    super(errors.map((e) => `${e.pointer || "/"} ${e.code}: ${e.message}`).join("\n"));
    this.name = "PlaceError";
    this.errors = errors;
  }
}
