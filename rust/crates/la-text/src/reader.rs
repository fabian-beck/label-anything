//! Bounds-checked big-endian reads: the only way font bytes are accessed.

/// A read or an offset went past the end of its data: the table is malformed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Malformed;

/// Result of parsing a piece of a font table.
pub(crate) type Parsed<T> = Result<T, Malformed>;

/// A view of font data. Offsets are relative to the start of the view.
#[derive(Clone, Copy)]
pub(crate) struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Reader(data)
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    /// Address of the first byte, used to recognise tables shared by several subtables.
    pub(crate) fn address(&self) -> usize {
        self.0.as_ptr() as usize
    }

    fn array<const N: usize>(&self, at: usize) -> Parsed<[u8; N]> {
        let end = at.checked_add(N).ok_or(Malformed)?;
        let bytes = self.0.get(at..end).ok_or(Malformed)?;
        let mut out = [0; N];
        out.copy_from_slice(bytes);
        Ok(out)
    }

    pub(crate) fn u16(&self, at: usize) -> Parsed<u16> {
        self.array(at).map(u16::from_be_bytes)
    }

    pub(crate) fn i16(&self, at: usize) -> Parsed<i16> {
        self.array(at).map(i16::from_be_bytes)
    }

    pub(crate) fn u32(&self, at: usize) -> Parsed<u32> {
        self.array(at).map(u32::from_be_bytes)
    }

    /// The data from `at` to the end.
    pub(crate) fn tail(&self, at: usize) -> Parsed<Reader<'a>> {
        self.0.get(at..).map(Reader).ok_or(Malformed)
    }

    /// `len` bytes starting at `at`.
    pub(crate) fn slice(&self, at: usize, len: usize) -> Parsed<Reader<'a>> {
        let end = at.checked_add(len).ok_or(Malformed)?;
        self.0.get(at..end).map(Reader).ok_or(Malformed)
    }

    /// Follows the 16-bit offset stored at `at`; `None` for a null offset.
    pub(crate) fn offset16(&self, at: usize) -> Parsed<Option<Reader<'a>>> {
        match self.u16(at)? {
            0 => Ok(None),
            offset => self.tail(usize::from(offset)).map(Some),
        }
    }

    /// Checks that `count` records of `size` bytes starting at `at` are inside the data.
    pub(crate) fn check_array(&self, at: usize, count: usize, size: usize) -> Parsed<()> {
        let len = count.checked_mul(size).ok_or(Malformed)?;
        self.slice(at, len).map(|_| ())
    }
}
