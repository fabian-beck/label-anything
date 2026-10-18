//! The global allocator: the standard one (dlmalloc), growing the memory in larger steps.
//!
//! dlmalloc grows the WebAssembly memory by just what each allocation needs, a few 64 KiB
//! pages at a time, and V8 runs a full garbage collection on every `memory.grow` (the
//! memory counts as external memory pressure): a first solve of 20,000 items grew it 437
//! times and spent most of its 6 s in the collector. Whenever the memory has grown, this
//! wrapper allocates and frees a block of half the memory size (at most 64 MiB), so the
//! next allocations find room and the memory grows by about 1.5x per step. dlmalloc on
//! wasm32 never returns memory, so the freed block stays available.

use std::alloc::{GlobalAlloc, Layout, System};
use std::arch::wasm32::memory_size;
use std::sync::atomic::{AtomicBool, Ordering};

const PAGE: usize = 64 * 1024;
const MAX_RESERVE: usize = 64 << 20;

pub struct Growing;

static RESERVING: AtomicBool = AtomicBool::new(false);

/// After an allocation that grew the memory from `pages`: reserves room for the next ones.
unsafe fn reserve_after(pages: usize) {
    let now = memory_size(0);
    if now > pages && !RESERVING.swap(true, Ordering::Relaxed) {
        let layout = Layout::from_size_align_unchecked((now * PAGE / 2).min(MAX_RESERVE), 16);
        let block = System.alloc(layout);
        if !block.is_null() {
            System.dealloc(block, layout);
        }
        RESERVING.store(false, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for Growing {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pages = memory_size(0);
        let p = System.alloc(layout);
        reserve_after(pages);
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pages = memory_size(0);
        let p = System.alloc_zeroed(layout);
        reserve_after(pages);
        p
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let pages = memory_size(0);
        let p = System.realloc(ptr, layout, new_size);
        reserve_after(pages);
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}
