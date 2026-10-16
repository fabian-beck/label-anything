//! Data parallelism for independent per-element work (feature `parallel`, rayon): the maps
//! keep the element order, so results never depend on the number of threads or on how
//! the work is split.

/// `(0..n).map(f).collect()`, in parallel with the `parallel` feature.
pub fn map<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync + Send) -> Vec<T> {
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        (0..n).into_par_iter().map(f).collect()
    }
    #[cfg(not(feature = "parallel"))]
    {
        (0..n).map(f).collect()
    }
}

/// The number of worker threads (1 without the `parallel` feature).
pub fn threads() -> usize {
    #[cfg(feature = "parallel")]
    {
        rayon::current_num_threads()
    }
    #[cfg(not(feature = "parallel"))]
    {
        1
    }
}

/// `f(k, chunk, scratch)` for the consecutive chunks of `len` elements of `data` (in
/// parallel with the `parallel` feature), each worker with scratch from `init`.
pub fn chunks_mut<T: Send, S>(
    data: &mut [T],
    len: usize,
    init: impl Fn() -> S + Sync + Send,
    f: impl Fn(usize, &mut [T], &mut S) + Sync + Send,
) {
    let len = len.max(1);
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        data.par_chunks_mut(len)
            .enumerate()
            .for_each_init(init, |s, (k, c)| f(k, c, s));
    }
    #[cfg(not(feature = "parallel"))]
    {
        let mut s = init();
        for (k, c) in data.chunks_mut(len).enumerate() {
            f(k, c, &mut s);
        }
    }
}
