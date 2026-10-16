/**
 * Stable error codes, shared with the Rust crate `label-anything-raster`
 * (`RasterErrorKind::code`).
 *
 * - `invalid_base64`: invalid character, misplaced padding or truncated quantum
 * - `invalid_data_url`: malformed `data:` URL (no `,`, bad percent escape)
 * - `unsupported_format`: not a PNG, JPEG or WebP signature
 * - `corrupt_image`: recognized format, but the file is corrupt or truncated
 * - `invalid_dimensions`: zero/overflowing size or pixel data of the wrong length
 * - `limit_exceeded`: decoded samples would exceed 512 MiB
 * - `unsupported`: not available in this environment (e.g. synchronous JPEG/WebP decoding)
 */
export type RasterErrorCode =
  | "invalid_base64"
  | "invalid_data_url"
  | "unsupported_format"
  | "corrupt_image"
  | "invalid_dimensions"
  | "limit_exceeded"
  | "unsupported";

/** A structured error of `@label-anything/raster`; branch on {@link RasterError.code}. */
export class RasterError extends Error {
  /** The stable machine-readable code. */
  readonly code: RasterErrorCode;

  constructor(code: RasterErrorCode, message: string) {
    super(message);
    this.name = "RasterError";
    this.code = code;
  }
}
