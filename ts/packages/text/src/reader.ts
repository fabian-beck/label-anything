/** A read or an offset went past the end of its data: the table is malformed. */
export class Malformed extends Error {
  constructor() {
    super("malformed font table");
  }
}

/** A bounds-checked big-endian view of font data. Offsets are relative to `start`. */
export class Reader {
  private constructor(
    private readonly view: DataView,
    /** Absolute position of the first byte (also identifies tables shared by subtables). */
    readonly start: number,
    private readonly end: number,
  ) {}

  static of(data: Uint8Array): Reader {
    return new Reader(new DataView(data.buffer, data.byteOffset, data.byteLength), 0, data.byteLength);
  }

  get length(): number {
    return this.end - this.start;
  }

  private position(at: number, size: number): number {
    const p = this.start + at;
    if (at < 0 || p + size > this.end) throw new Malformed();
    return p;
  }

  u16(at: number): number {
    return this.view.getUint16(this.position(at, 2));
  }

  i16(at: number): number {
    return this.view.getInt16(this.position(at, 2));
  }

  u32(at: number): number {
    return this.view.getUint32(this.position(at, 4));
  }

  /** The data from `at` to the end. */
  tail(at: number): Reader {
    return new Reader(this.view, this.position(at, 0), this.end);
  }

  /** `length` bytes starting at `at`. */
  slice(at: number, length: number): Reader {
    const p = this.position(at, length);
    return new Reader(this.view, p, p + length);
  }

  /** Follows the 16-bit offset stored at `at`; `null` for a null offset. */
  offset16(at: number): Reader | null {
    const offset = this.u16(at);
    return offset === 0 ? null : this.tail(offset);
  }

  /** Checks that `count` records of `size` bytes starting at `at` are inside the data. */
  checkArray(at: number, count: number, size: number): void {
    this.position(at, count * size);
  }
}
