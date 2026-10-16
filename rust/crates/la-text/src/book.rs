//! A registry of fonts keyed by family, weight and style.

use std::sync::Arc;

use crate::{Font, TextError};

/// Identifies a font of a [`FontBook`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FontId(usize);

impl FontId {
    /// Position of the font in its book (0 for the first font).
    pub fn index(self) -> usize {
        self.0
    }
}

struct Entry {
    family: String,
    weight: u16,
    italic: bool,
    font: FontId,
}

/// Fonts by `(family, weight, italic)`.
///
/// [`FontBook::resolve`] picks the font for a request: the family (ASCII case-insensitive),
/// else `"default"`, else the family of the first registered font; within the family the
/// requested style if available; then the nearest weight (smallest |Δ|, ties → the lighter
/// weight, identical entries → the most recently registered).
pub struct FontBook {
    fonts: Vec<Arc<Font>>,
    entries: Vec<Entry>,
}

#[cfg(feature = "bundled-font")]
static REGULAR: &[u8] = include_bytes!("../assets/NotoSans-Regular.metrics.ttf");
#[cfg(feature = "bundled-font")]
static BOLD: &[u8] = include_bytes!("../assets/NotoSans-Bold.metrics.ttf");

/// The bundled Noto Sans Regular and Bold, parsed once per process.
#[cfg(feature = "bundled-font")]
fn bundled() -> &'static [Arc<Font>; 2] {
    static FONTS: std::sync::OnceLock<[Arc<Font>; 2]> = std::sync::OnceLock::new();
    FONTS.get_or_init(|| {
        let load = |data| Arc::new(Font::from_static(data).expect("the bundled font is valid"));
        [load(REGULAR), load(BOLD)]
    })
}

impl FontBook {
    /// A book without fonts.
    pub fn empty() -> FontBook {
        FontBook {
            fonts: Vec::new(),
            entries: Vec::new(),
        }
    }

    /// The bundled Noto Sans subset (Latin, Greek, Cyrillic; metrics only) as the families
    /// `"default"` and `"Noto Sans"`, weights 400 and 700, upright.
    #[cfg(feature = "bundled-font")]
    pub fn with_bundled() -> FontBook {
        let [regular, bold] = bundled().clone();
        let mut book = FontBook {
            fonts: vec![regular, bold],
            entries: Vec::new(),
        };
        for family in ["default", "Noto Sans"] {
            for (weight, font) in [(400, FontId(0)), (700, FontId(1))] {
                book.entries.push(Entry {
                    family: family.to_owned(),
                    weight,
                    italic: false,
                    font,
                });
            }
        }
        book
    }

    /// Parses `data` (see [`Font::from_bytes`]) and registers it.
    pub fn register(
        &mut self,
        family: &str,
        weight: u16,
        italic: bool,
        data: Vec<u8>,
    ) -> Result<FontId, TextError> {
        let font = Font::from_bytes(data)?;
        let id = FontId(self.fonts.len());
        self.fonts.push(Arc::new(font));
        self.entries.push(Entry {
            family: family.to_owned(),
            weight,
            italic,
            font: id,
        });
        Ok(id)
    }

    /// The font for a request (see the [type docs](FontBook)).
    ///
    /// # Panics
    /// If the book is empty.
    pub fn resolve(&self, family: &str, weight: u16, italic: bool) -> FontId {
        let has = |name: &str| {
            self.entries
                .iter()
                .any(|e| e.family.eq_ignore_ascii_case(name))
        };
        let family = if has(family) {
            family
        } else if has("default") {
            "default"
        } else {
            &self
                .entries
                .first()
                .expect("FontBook::resolve needs at least one font")
                .family
        };
        let in_family = || {
            self.entries
                .iter()
                .filter(|e| e.family.eq_ignore_ascii_case(family))
        };
        let style = if in_family().any(|e| e.italic == italic) {
            italic
        } else {
            !italic
        };
        let mut best: Option<&Entry> = None;
        for entry in in_family().filter(|e| e.italic == style) {
            let better = best.is_none_or(|b| {
                let (d, db) = (entry.weight.abs_diff(weight), b.weight.abs_diff(weight));
                d < db || (d == db && entry.weight <= b.weight)
            });
            if better {
                best = Some(entry);
            }
        }
        best.map(|e| e.font).expect("the family has an entry")
    }

    /// The font with this id.
    ///
    /// # Panics
    /// If `id` does not belong to this book.
    pub fn font(&self, id: FontId) -> &Font {
        &self.fonts[id.0]
    }
}

#[cfg(all(test, feature = "bundled-font"))]
mod tests {
    use super::*;

    #[test]
    fn resolves_family_style_and_weight() {
        let book = FontBook::with_bundled();
        assert_eq!(book.resolve("default", 400, false), FontId(0));
        assert_eq!(book.resolve("NOTO SANS", 700, false), FontId(1));
        assert_eq!(book.resolve("Unknown", 900, true), FontId(1));
        assert_eq!(book.resolve("default", 550, false), FontId(0)); // tie → lighter
        assert_eq!(book.resolve("default", 551, false), FontId(1));
        assert_eq!(book.resolve("default", 100, false), FontId(0));
    }

    #[test]
    fn registered_fonts_override_and_italic_is_preferred() {
        let mut book = FontBook::with_bundled();
        let italic = book
            .register("default", 400, true, REGULAR.to_vec())
            .unwrap();
        assert_eq!(book.resolve("default", 700, true), italic);
        assert_eq!(book.resolve("default", 700, false), FontId(1));
        let shadow = book.register("default", 700, false, BOLD.to_vec()).unwrap();
        assert_eq!(book.resolve("default", 700, false), shadow);
        assert_eq!(book.font(shadow).units_per_em(), 1000);

        let mut custom = FontBook::empty();
        let only = custom
            .register("Custom", 300, false, REGULAR.to_vec())
            .unwrap();
        assert_eq!(custom.resolve("default", 400, true), only);
    }
}
