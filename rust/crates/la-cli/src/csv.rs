//! Minimal CSV reader for `place --anchors` (RFC 4180 quoting, comma separator).

use serde_json::{json, Value};
use std::path::Path;

pub struct CsvOpts {
    pub x_col: String,
    pub y_col: String,
    pub labels_col: String,
    pub id_col: Option<String>,
    pub priority_col: Option<String>,
}

/// Parse CSV text into rows of fields.
pub fn parse(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                if !(row.len() == 1 && row[0].is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// Build a problem from a CSV of anchors. Extra numeric columns become `attrs`.
pub fn problem_from_csv(path: &Path, o: &CsvOpts) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let rows = parse(&text);
    let Some((header, data)) = rows.split_first() else {
        return Err("empty CSV".into());
    };
    let col = |name: &str| header.iter().position(|h| h.trim() == name);
    let xi = col(&o.x_col).ok_or_else(|| format!("CSV has no column '{}'", o.x_col))?;
    let yi = col(&o.y_col).ok_or_else(|| format!("CSV has no column '{}'", o.y_col))?;
    let li = col(&o.labels_col).ok_or_else(|| format!("CSV has no column '{}'", o.labels_col))?;
    let idi = o
        .id_col
        .as_deref()
        .map(|c| col(c).ok_or_else(|| format!("CSV has no column '{c}'")))
        .transpose()?;
    let pi = o
        .priority_col
        .as_deref()
        .map(|c| col(c).ok_or_else(|| format!("CSV has no column '{c}'")))
        .transpose()?;
    let mut items = Vec::new();
    for (r, row) in data.iter().enumerate() {
        let get = |i: usize| row.get(i).map(|s| s.trim()).unwrap_or("");
        let x: f64 = get(xi)
            .parse()
            .map_err(|_| format!("row {}: invalid x '{}'", r + 2, get(xi)))?;
        let y: f64 = get(yi)
            .parse()
            .map_err(|_| format!("row {}: invalid y '{}'", r + 2, get(yi)))?;
        let mut attrs = serde_json::Map::new();
        for (k, h) in header.iter().enumerate() {
            if k == xi || k == yi || k == li {
                continue;
            }
            let v = get(k);
            if let Ok(n) = v.parse::<f64>() {
                attrs.insert(h.trim().to_string(), json!(n));
            } else if !v.is_empty() {
                attrs.insert(h.trim().to_string(), json!(v));
            }
        }
        let mut item = json!({
            "id": idi.map(|i| get(i).to_string()).unwrap_or_else(|| r.to_string()),
            "anchor": {"type": "point", "x": x, "y": y},
            "label": {"type": "text", "text": get(li)},
            "attrs": attrs,
        });
        if let Some(p) = pi {
            if let Ok(v) = get(p).parse::<f64>() {
                item["priority"] = json!(v);
            }
        }
        items.push(item);
    }
    Ok(json!({ "version": "1", "items": items }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        let r = parse("a,b,c\n1,\"x, \"\"y\"\"\",3\n");
        assert_eq!(r, vec![vec!["a", "b", "c"], vec!["1", "x, \"y\"", "3"]]);
    }
}
