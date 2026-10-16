import { describe, expect, it } from "vitest";
import {
  balancedWrap,
  breakOpportunities as breaks,
  extraWrapVariants,
  greedyWrap,
  truncateEnd,
  truncateMiddle,
  wrapVariants,
  type WrapOptions,
} from "../src/index.js";

/** Every code point is 1 wide, spaces too. */
const count = (s: string): number => [...s].length;

describe("break opportunities", () => {
  it("spaces and punctuation", () => {
    expect(breaks("a b")).toEqual([1]);
    expect(breaks("a  b")).toEqual([1, 2]);
    expect(breaks("org.example.Foo")).toEqual([3, 11]);
    expect(breaks("a/b\\c_d-e,f;g:h|i")).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(breaks("10 km")).toEqual([]);
    expect(breaks("end.")).toEqual([]);
  });

  it("colons and numbers", () => {
    expect(breaks("std::vec")).toEqual([4]);
    expect(breaks("a:::b")).toEqual([3]);
    expect(breaks("3.14 and 1,000")).toEqual([4, 8]);
    expect(breaks("v1.x")).toEqual([2]);
    expect(breaks("x.5")).toEqual([1]);
  });

  it("camelCase and acronyms", () => {
    expect(breaks("camelCase")).toEqual([4]);
    expect(breaks("XMLHttpRequest")).toEqual([2, 6]);
    expect(breaks("ABC")).toEqual([]);
    expect(breaks("getHTTP")).toEqual([2]);
    expect(breaks("ΑθήναΚαι")).toEqual([4]);
  });

  it("CJK and marks; indices are code points", () => {
    expect(breaks("中文字")).toEqual([0, 1]);
    expect(breaks("a中")).toEqual([]);
    expect(breaks("a ́b")).toEqual([]);
    expect(breaks("é-x")).toEqual([2]);
    expect(breaks("\u{20000}\u{20001} x")).toEqual([0, 2]);
  });
});

describe("wrapping", () => {
  it("greedy takes the largest fitting break", () => {
    expect(greedyWrap("aaa bbb ccc", 7, count)).toEqual(["aaa bbb", "ccc"]);
    expect(greedyWrap("aaa bbb ccc", 6, count)).toEqual(["aaa", "bbb", "ccc"]);
    expect(greedyWrap("org.example.Foo", 12, count)).toEqual(["org.example.", "Foo"]);
    expect(greedyWrap("  lead  trail  ", 100, count)).toEqual(["lead  trail"]);
    expect(greedyWrap("", 10, count)).toEqual([""]);
    expect(greedyWrap("   ", 10, count)).toEqual([""]);
  });

  it("emergency breaks", () => {
    expect(greedyWrap("abcdefgh", 3, count)).toEqual(["abc", "def", "gh"]);
    expect(greedyWrap("ab cdefgh", 3, count)).toEqual(["ab", "cde", "fgh"]);
    expect(greedyWrap("abc", 0, count)).toEqual(["a", "b", "c"]);
    expect(greedyWrap("aéb", 2, count)).toEqual(["a", "é", "b"]);
    expect(greedyWrap("é̂x", 1, count)).toEqual(["é̂", "x"]);
    expect(greedyWrap("\u{1F600}\u{1F600}\u{1F600}", 2, count)).toEqual(["\u{1F600}\u{1F600}", "\u{1F600}"]);
  });

  it("balanced", () => {
    expect(balancedWrap("aaa bbb ccc ddd", 2, null, count)).toEqual(["aaa bbb", "ccc ddd"]);
    expect(balancedWrap("aaa bbb ccc ddd", 1, undefined, count)).toEqual(["aaa bbb ccc ddd"]);
    expect(balancedWrap("aaaaaaaa b c", 2, null, count)).toEqual(["aaaaaaaa", "b c"]);
    expect(balancedWrap("aaa bbb ccc ddd", 2, 5, count)).toEqual(["aaa", "bbb", "ccc", "ddd"]);
    expect(balancedWrap("", 2, null, count)).toEqual([""]);
  });

  it("truncation", () => {
    expect(truncateEnd("abcdef", 6, count)).toBe("abcdef");
    expect(truncateEnd("abcdef", 4, count)).toBe("abc…");
    expect(truncateEnd("ab cdef", 4, count)).toBe("ab…");
    expect(truncateEnd("abéf", 4, count)).toBe("ab…");
    expect(truncateEnd("abc", 0, count)).toBe("…");
    expect(truncateMiddle("org.example.Foo", 7, 1, count)).toEqual(["org…Foo"]);
    expect(truncateMiddle("abcdefgh", 5, 1, count)).toEqual(["ab…gh"]);
    expect(truncateMiddle("abc defgh", 5, 1, count)).toEqual(["ab…gh"]);
    expect(truncateMiddle("abc", 5, 1, count)).toEqual(["abc"]);
  });

  it("variants", () => {
    const opts: WrapOptions = { maxWidth: 8, maxLines: 3 };
    const v = wrapVariants("aa bb cc dd ee ff", opts, count);
    expect(v.map((x) => x.lines)).toEqual([
      ["aa bb cc", "dd ee ff"],
      ["aa bb", "cc dd", "ee ff"],
    ]);
    expect(v[0].widths).toEqual([8, 8]);
    expect(wrapVariants("aaa bbb ccc ddd", { ...opts, maxWidth: 7 }, count)).toHaveLength(1);
    expect(wrapVariants("aa bb cc dd ee ff", { ...opts, balance: false }, count)[0].lines).toEqual([
      "aa bb cc",
      "dd ee ff",
    ]);

    const end: WrapOptions = { maxWidth: 7, maxLines: 1, truncate: "end" };
    expect(wrapVariants("aaa bbb ccc ddd", end, count)).toEqual([{ lines: ["aaa bb…"], widths: [7], truncated: true }]);
    expect(wrapVariants("aaa bbb ccc ddd", { ...end, maxLines: 2, maxWidth: 4 }, count)[0].lines).toEqual([
      "aaa",
      "bbb…",
    ]);
    expect(wrapVariants("aaa bbb ccc ddd", { ...end, truncate: "middle" }, count)[0].lines).toEqual(["aaa…ddd"]);
    // "none" keeps the text within maxLines; lines may exceed maxWidth
    const none = wrapVariants("aaa bbb ccc ddd", { ...end, truncate: "none", maxLines: 2, maxWidth: 4 }, count);
    expect([none[0].lines, none[0].truncated]).toEqual([["aaa bbb", "ccc ddd"], false]);
    expect(wrapVariants("aaa bbb ccc", { maxLines: 2 }, count).map((x) => x.lines)).toEqual([
      ["aaa bbb ccc"],
      ["aaa bbb", "ccc"],
    ]);
  });

  it("extra variants", () => {
    expect(extraWrapVariants("aaa bbb ccc", 3, count).map((x) => x.lines)).toEqual([
      ["aaa bbb", "ccc"],
      ["aaa", "bbb", "ccc"],
    ]);
    expect(extraWrapVariants("unbreakable", 3, count)).toEqual([]);
    expect(extraWrapVariants("a b", Infinity, count).map((x) => x.lines)).toEqual([["a", "b"]]);
  });
});
