//! Minimal CSV reader for `place --anchors` (RFC 4180 quoting, comma separator).

use serde_json::{json, Value};

pub struct CsvOpts {
    pub x_col: String,
    pub y_col: String,
    pub labels_col: String,
    pub id_col: Option<String>,
    pub priority_col: Option<String>,
}

/// Parse CSV text into rows of fields, each with the line number it starts on (1-based).
/// A leading UTF-8 byte order mark is skipped; blank lines are not rows.
pub fn parse(text: &str) -> Vec<(usize, Vec<String>)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let (mut line, mut start) = (1, 1);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            line += 1;
        }
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
                    rows.push((start, std::mem::take(&mut row)));
                } else {
                    row.clear();
                }
                start = line;
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push((start, row));
    }
    rows
}

/// Build a problem from the text of a CSV of anchors (`name` names it in messages). Other
/// columns become `attrs` (numbers where they parse as finite numbers, else strings). Rows
/// with an empty label are not labeled: their points become the obstacle class `points`.
/// Errors name the CSV row and column.
pub fn problem_from_csv(text: &str, name: &str, o: &CsvOpts) -> Result<Value, String> {
    let rows = parse(text);
    let Some(((_, header), data)) = rows.split_first() else {
        return Err(format!("{name}: empty CSV"));
    };
    let col = |c: &str, flag: &str| {
        header.iter().position(|h| h.trim() == c).ok_or_else(|| {
            let names: Vec<&str> = header.iter().map(|h| h.trim()).collect();
            format!(
                "{name}: no column '{c}' (columns: {}); choose one with {flag}",
                names.join(", ")
            )
        })
    };
    let xi = col(&o.x_col, "--x-col")?;
    let yi = col(&o.y_col, "--y-col")?;
    let li = col(&o.labels_col, "--labels-col")?;
    let idi = o
        .id_col
        .as_deref()
        .map(|c| col(c, "--id-col"))
        .transpose()?;
    let pi = o
        .priority_col
        .as_deref()
        .map(|c| col(c, "--priority-col"))
        .transpose()?;
    let finite = |s: &str| s.parse::<f64>().ok().filter(|v| v.is_finite());
    let mut items = Vec::new();
    let mut unlabeled = Vec::new();
    for (r, (line, row)) in data.iter().enumerate() {
        let get = |i: usize| row.get(i).map(|s| s.trim()).unwrap_or("");
        let number = |i: usize| {
            finite(get(i)).ok_or_else(|| {
                format!(
                    "{name}: row {line}, column '{}': '{}' is not a finite number",
                    header[i].trim(),
                    get(i)
                )
            })
        };
        let (x, y) = (number(xi)?, number(yi)?);
        if get(li).is_empty() {
            unlabeled.push(json!([x, y]));
            continue;
        }
        let mut attrs = serde_json::Map::new();
        for (k, h) in header.iter().enumerate() {
            if k == xi || k == yi || k == li {
                continue;
            }
            let v = get(k);
            if let Some(n) = finite(v) {
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
        // an empty priority cell leaves the item without an explicit priority
        if let Some(p) = pi.filter(|&p| !get(p).is_empty()) {
            item["priority"] = json!(number(p)?);
        }
        items.push(item);
    }
    let mut problem = json!({ "version": "1", "items": items });
    if !unlabeled.is_empty() {
        problem["obstacles"] = json!({"vector": [{"class": "points", "points": unlabeled}]});
    }
    Ok(problem)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> CsvOpts {
        CsvOpts {
            x_col: "x".into(),
            y_col: "y".into(),
            labels_col: "label".into(),
            id_col: None,
            priority_col: Some("pop".into()),
        }
    }

    #[test]
    fn quoting() {
        let r = parse("a,b,c\n1,\"x, \"\"y\"\"\",3\n");
        assert_eq!(
            r,
            vec![
                (1, vec!["a".into(), "b".into(), "c".into()]),
                (2, vec!["1".into(), "x, \"y\"".into(), "3".into()])
            ]
        );
    }

    #[test]
    fn byte_order_mark_and_line_numbers() {
        let r = parse("\u{feff}x,y\n\n1,\"a\nb\"\n3,4");
        assert_eq!(r[0].1, vec!["x", "y"]);
        assert_eq!((r[1].0, r[2].0), (3, 5));
    }

    #[test]
    fn rows_and_columns_in_errors() {
        let bad = |csv: &str| problem_from_csv(csv, "t.csv", &opts()).unwrap_err();
        assert_eq!(
            bad("x,y,label,pop\n1,2,A,\n3,NaN,B,\n"),
            "t.csv: row 3, column 'y': 'NaN' is not a finite number"
        );
        assert_eq!(
            bad("x,y,label,pop\n1e400,2,A,1\n"),
            "t.csv: row 2, column 'x': '1e400' is not a finite number"
        );
        assert_eq!(
            bad("x,y,label,pop\n1,2,A,big\n"),
            "t.csv: row 2, column 'pop': 'big' is not a finite number"
        );
        assert_eq!(
            bad("name,x,y,pop\n"),
            "t.csv: no column 'label' (columns: name, x, y, pop); choose one with --labels-col"
        );
    }

    #[test]
    fn empty_labels_are_obstacles() {
        let p = problem_from_csv("x,y,label,pop\n1,2,A,\n3,4,,5\n5,6,C,inf\n", "t.csv", &{
            let mut o = opts();
            o.priority_col = None;
            o
        })
        .unwrap();
        assert_eq!(p["items"].as_array().unwrap().len(), 2);
        assert_eq!(p["items"][1]["id"], "2");
        assert_eq!(p["items"][1]["attrs"]["pop"], "inf");
        assert_eq!(p["obstacles"]["vector"][0]["points"], json!([[3.0, 4.0]]));
        let p = problem_from_csv("x,y,label,pop\n1,2,A,\n", "t.csv", &opts()).unwrap();
        assert!(p["items"][0].get("priority").is_none());
    }
}
