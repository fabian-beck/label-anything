//! Uniform-grid spatial indexes: a static CSR index and a dynamic one (insert/remove).
//!
//! Queries return ids without duplicates in bucket scan order (rows, then columns, then
//! bucket order). That order is a deterministic function of the index's construction and
//! of the sequence of inserts and removals, so it is reproducible across runs and across
//! implementations that mirror these structures.

use crate::geom::Rect;

/// Bucket grid geometry.
#[derive(Clone, Copy, Debug)]
struct Buckets {
    ox: f64,
    oy: f64,
    cell: f64,
    cols: usize,
    rows: usize,
}

impl Buckets {
    fn new(extent: &Rect, cell: f64) -> Buckets {
        let cell = if cell > 0.0 { cell } else { 32.0 };
        let cols = ((extent.w() / cell).ceil() as usize).clamp(1, 4096);
        let rows = ((extent.h() / cell).ceil() as usize).clamp(1, 4096);
        Buckets {
            ox: extent.x0,
            oy: extent.y0,
            cell,
            cols,
            rows,
        }
    }
    #[inline]
    fn range(&self, r: &Rect) -> (usize, usize, usize, usize) {
        let c0 = ((r.x0 - self.ox) / self.cell).floor();
        let c1 = ((r.x1 - self.ox) / self.cell).floor();
        let r0 = ((r.y0 - self.oy) / self.cell).floor();
        let r1 = ((r.y1 - self.oy) / self.cell).floor();
        let cl = |v: f64, n: usize| -> usize {
            if v < 0.0 {
                0
            } else if v >= n as f64 {
                n - 1
            } else {
                v as usize
            }
        };
        (
            cl(c0, self.cols),
            cl(c1, self.cols),
            cl(r0, self.rows),
            cl(r1, self.rows),
        )
    }
}

/// Static index over a fixed set of bounding boxes (compressed sparse rows).
#[derive(Debug)]
pub struct StaticIndex {
    b: Buckets,
    offsets: Vec<u32>,
    ids: Vec<u32>,
    boxes: Vec<Rect>,
    stamp: std::cell::RefCell<(Vec<u32>, u32)>,
}

impl StaticIndex {
    pub fn new(boxes: Vec<Rect>, extent: &Rect, cell: f64) -> StaticIndex {
        let b = Buckets::new(extent, cell);
        let mut counts = vec![0u32; b.cols * b.rows + 1];
        for r in &boxes {
            if r.is_empty() {
                continue;
            }
            let (c0, c1, r0, r1) = b.range(r);
            for row in r0..=r1 {
                for col in c0..=c1 {
                    counts[row * b.cols + col + 1] += 1;
                }
            }
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let mut fill = counts.clone();
        let mut ids = vec![0u32; *counts.last().unwrap_or(&0) as usize];
        for (id, r) in boxes.iter().enumerate() {
            if r.is_empty() {
                continue;
            }
            let (c0, c1, r0, r1) = b.range(r);
            for row in r0..=r1 {
                for col in c0..=c1 {
                    let k = row * b.cols + col;
                    ids[fill[k] as usize] = id as u32;
                    fill[k] += 1;
                }
            }
        }
        let n = boxes.len();
        StaticIndex {
            b,
            offsets: counts,
            ids,
            boxes,
            stamp: std::cell::RefCell::new((vec![0; n], 0)),
        }
    }

    pub fn len(&self) -> usize {
        self.boxes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.boxes.is_empty()
    }
    pub fn bbox(&self, id: u32) -> &Rect {
        &self.boxes[id as usize]
    }

    /// Ids whose boxes touch `r` (closed), deduplicated, in bucket scan order
    /// (row-major, first occurrence) — deterministic for a given index.
    pub fn query(&self, r: &Rect, out: &mut Vec<u32>) {
        out.clear();
        if self.boxes.is_empty() {
            return;
        }
        let (c0, c1, r0, r1) = self.b.range(r);
        if c0 == c1 && r0 == r1 {
            let k = r0 * self.b.cols + c0;
            for &id in &self.ids[self.offsets[k] as usize..self.offsets[k + 1] as usize] {
                if self.boxes[id as usize].touches(r) {
                    out.push(id);
                }
            }
            return;
        }
        let mut st = self.stamp.borrow_mut();
        st.1 = st.1.wrapping_add(1);
        if st.1 == 0 {
            st.0.iter_mut().for_each(|x| *x = 0);
            st.1 = 1;
        }
        let gen = st.1;
        for row in r0..=r1 {
            for col in c0..=c1 {
                let k = row * self.b.cols + col;
                for &id in &self.ids[self.offsets[k] as usize..self.offsets[k + 1] as usize] {
                    let slot = &mut st.0[id as usize];
                    if *slot != gen {
                        *slot = gen;
                        if self.boxes[id as usize].touches(r) {
                            out.push(id);
                        }
                    }
                }
            }
        }
    }
}

/// Dynamic index (placed labels, leader segments). Removal is O(bucket size).
#[derive(Clone, Debug)]
pub struct DynIndex {
    b: Buckets,
    buckets: Vec<Vec<u32>>,
    boxes: Vec<Option<Rect>>,
    stamp: Vec<u32>,
    gen: u32,
}

impl DynIndex {
    pub fn new(extent: &Rect, cell: f64) -> DynIndex {
        let b = Buckets::new(extent, cell);
        DynIndex {
            b,
            buckets: vec![Vec::new(); b.cols * b.rows],
            boxes: Vec::new(),
            stamp: Vec::new(),
            gen: 0,
        }
    }

    /// Insert with an explicit id (ids are small integers chosen by the caller).
    pub fn insert(&mut self, id: u32, r: Rect) {
        if self.boxes.len() <= id as usize {
            self.boxes.resize(id as usize + 1, None);
        }
        if self.boxes[id as usize].is_some() {
            self.remove(id);
        }
        self.boxes[id as usize] = Some(r);
        let (c0, c1, r0, r1) = self.b.range(&r);
        for row in r0..=r1 {
            for col in c0..=c1 {
                self.buckets[row * self.b.cols + col].push(id);
            }
        }
    }

    pub fn remove(&mut self, id: u32) {
        let Some(Some(r)) = self.boxes.get(id as usize).copied() else {
            return;
        };
        let (c0, c1, r0, r1) = self.b.range(&r);
        for row in r0..=r1 {
            for col in c0..=c1 {
                let v = &mut self.buckets[row * self.b.cols + col];
                if let Some(p) = v.iter().position(|&x| x == id) {
                    v.swap_remove(p);
                }
            }
        }
        self.boxes[id as usize] = None;
    }

    pub fn get(&self, id: u32) -> Option<&Rect> {
        self.boxes.get(id as usize).and_then(|b| b.as_ref())
    }

    /// Ids whose boxes touch `r`, deduplicated, in bucket scan order (deterministic for a
    /// given history of inserts and removals; removal swaps the last bucket entry in).
    pub fn query(&mut self, r: &Rect, out: &mut Vec<u32>) {
        out.clear();
        let (c0, c1, r0, r1) = self.b.range(r);
        if self.stamp.len() < self.boxes.len() {
            self.stamp.resize(self.boxes.len(), 0);
        }
        self.gen = self.gen.wrapping_add(1);
        if self.gen == 0 {
            self.stamp.iter_mut().for_each(|x| *x = 0);
            self.gen = 1;
        }
        for row in r0..=r1 {
            for col in c0..=c1 {
                for &id in &self.buckets[row * self.b.cols + col] {
                    let slot = &mut self.stamp[id as usize];
                    if *slot == self.gen {
                        continue;
                    }
                    *slot = self.gen;
                    if let Some(Some(b)) = self.boxes.get(id as usize) {
                        if b.touches(r) {
                            out.push(id);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_query() {
        let boxes = vec![
            Rect::xywh(0.0, 0.0, 10.0, 10.0),
            Rect::xywh(50.0, 50.0, 5.0, 5.0),
            Rect::xywh(5.0, 5.0, 100.0, 2.0),
        ];
        let ix = StaticIndex::new(boxes, &Rect::xywh(0.0, 0.0, 200.0, 200.0), 16.0);
        let mut out = Vec::new();
        ix.query(&Rect::xywh(8.0, 8.0, 1.0, 1.0), &mut out);
        assert_eq!(out, vec![0]);
        ix.query(&Rect::xywh(0.0, 0.0, 60.0, 60.0), &mut out);
        out.sort_unstable();
        assert_eq!(out, vec![0, 1, 2]);
    }

    #[test]
    fn dynamic_insert_remove() {
        let mut ix = DynIndex::new(&Rect::xywh(0.0, 0.0, 100.0, 100.0), 10.0);
        ix.insert(3, Rect::xywh(0.0, 0.0, 30.0, 30.0));
        ix.insert(1, Rect::xywh(20.0, 20.0, 5.0, 5.0));
        let mut out = Vec::new();
        ix.query(&Rect::xywh(21.0, 21.0, 1.0, 1.0), &mut out);
        out.sort_unstable();
        assert_eq!(out, vec![1, 3]);
        ix.remove(3);
        ix.query(&Rect::xywh(21.0, 21.0, 1.0, 1.0), &mut out);
        assert_eq!(out, vec![1]);
    }
}
