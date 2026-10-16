/** Error thrown when font data cannot be loaded. */
export class TextError extends Error {
  /**
   * `invalid_font`: the data is not a usable TrueType/OpenType font.
   * `unsupported`: a font format this package cannot read (WOFF, WOFF2).
   */
  readonly code: "invalid_font" | "unsupported";

  constructor(code: "invalid_font" | "unsupported", message: string) {
    super(code === "invalid_font" ? `invalid font: ${message}` : `unsupported font format: ${message}`);
    this.name = "TextError";
    this.code = code;
  }
}
