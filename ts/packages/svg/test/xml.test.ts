// XML parser: the same accept/reject expectations as the Rust tests (which are checked
// against roxmltree), plus tree-shape checks.

import { describe, expect, it } from "vitest";
import { SvgFailure } from "../src/error.js";
import { type XmlDoc, parseXml, plainAttr } from "../src/xml.js";

function parses(s: string): XmlDoc | SvgFailure {
  try {
    return parseXml(s);
  } catch (e) {
    if (e instanceof SvgFailure) return e;
    throw e;
  }
}

const ACCEPTED = [
  "<svg/>",
  "\u{FEFF}<svg/>",
  '<?xml version="1.0"?><svg/>',
  "<svg><!-- c --><?pi x?></svg>",
  "<svg a='1' b=\"2\" xmlns='urn:x' xmlns:p='urn:p' p:c='3'/>",
  "<svg>a<![CDATA[b]]>c<!--x-->d</svg>",
  "<!DOCTYPE s [<!ENTITY m \"<g id='q'>in</g>\">]><svg>a&m;b</svg>",
  "<!DOCTYPE s [<!ENTITY a \"x\"><!ENTITY b \"&a;&a;\">]><svg t='&b;'>&b;</svg>",
  '<svg a="x&#10;y&#9;z" b="p\tq\nr\r\ns"/>',
  "<svg>a\r\nb\rc&#13;d</svg>",
  "<svg :a='1'/>",
  "<s:svg xmlns:s='http://www.w3.org/2000/svg'><s:rect s:fill='red'/></s:svg>",
  "<svg xmlns='urn:a'><g xmlns=''><rect/></g></svg>",
  "<svg>&#x110000;&#xD800;</svg>",
  "<svg></svg >",
  "<svg\ta='1'\n/>",
  "<!DOCTYPE svg SYSTEM 'x.dtd'><svg/>",
];

const REJECTED = [
  "",
  "abc<svg/>",
  "<svg/>abc",
  "<svg/><svg/>",
  "<svg><g></svg>",
  "<svg a='1' a='2'/>",
  "<svg x:a='1'/>",
  "<svg>&nbsp;</svg>",
  "<svg><!-- a -- b --></svg>",
  "<svg>\u{1}</svg>",
  "<svg a='<'/>",
  "<svg>a ]]> b</svg>",
  "<svg>a & b</svg>",
  "<svg><?xml version='1.0'?></svg>",
  "<svg a='1'b='2'/>",
  "<svg a=1/>",
  "<svg/><!DOCTYPE x>",
  '<!DOCTYPE svg [<!ENTITY % p "x"> %p;]><svg/>',
  '<!DOCTYPE s [<!ENTITY e SYSTEM "foo.xml">]><svg>&e;</svg>',
  "<svg>&#0;</svg>",
  "<1svg/>",
  "<!doctype svg><svg/>",
  "<svg>&#X41;</svg>",
  "<svg a='&#;'/>",
  "<svg>\u{FFFE}</svg>",
  "<a:svg xmlns:a='u' xmlns:b='u'></b:svg>",
  "<?xml encoding='utf-8'?><svg/>",
  "<svg><!-- a ---></svg>",
  '<!DOCTYPE s [<!ENTITY b "&zz;">]><svg>&b;</svg>',
  "<svg xmlns='urn:a' xmlns='urn:a'/>",
  "<svg>\uD800</svg>",
];

describe("xml", () => {
  it("accepts well-formed documents", () => {
    for (const s of ACCEPTED) expect(parses(s), JSON.stringify(s)).not.toBeInstanceOf(SvgFailure);
  });

  it("rejects malformed documents with code 'parse'", () => {
    for (const s of REJECTED) {
      const r = parses(s);
      expect(r, JSON.stringify(s)).toBeInstanceOf(SvgFailure);
      expect((r as SvgFailure).error.code).toBe("parse");
      expect((r as SvgFailure).error.message).toMatch(/line \d+, column \d+|no root/);
    }
  });

  it("merges text and CDATA, expands entities and normalizes", () => {
    const d = parseXml("<svg>a<![CDATA[b]]>c<!--x-->d&amp;&#x41;\r\ne</svg>");
    expect(d.elements[0]!.children).toEqual(["abc", "d&A\ne"]);
    const e = parseXml("<!DOCTYPE s [<!ENTITY m \"<g id='q'>in</g>\">]><svg>a&m;b</svg>");
    expect(e.elements.map((x) => x.qname)).toEqual(["svg", "g"]);
    expect(e.elements[0]!.children).toEqual(["a", 1, "b"]);
    expect(plainAttr(e.elements[1]!, "id")).toBe("q");
    const a = parseXml('<svg a="x&#10;y&#9;z" b="p\tq\nr\r\ns"/>');
    expect(plainAttr(a.elements[0]!, "a")).toBe("x\ny\tz");
    expect(plainAttr(a.elements[0]!, "b")).toBe("p q r s");
  });

  it("resolves namespaces", () => {
    const d = parseXml(
      "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'><use xlink:href='#a' xml:space='preserve'/><x:g xmlns:x='urn:x'/></svg>",
    );
    const use = d.elements[1]!;
    expect(use.attrs).toEqual(["xlink:href", "#a", "xml:space", "preserve"]);
    expect(use.attrNs!.map((k) => d.namespaces[k!])).toEqual(["http://www.w3.org/1999/xlink", "http://www.w3.org/XML/1998/namespace"]);
    expect(d.namespaces[d.elements[0]!.ns!]).toBe("http://www.w3.org/2000/svg");
    expect(d.namespaces[d.elements[2]!.ns!]).toBe("urn:x");
    expect(plainAttr(use, "href")).toBeUndefined();
  });

  it("enforces limits", () => {
    const deep = `<svg>${"<g>".repeat(1100)}${"</g>".repeat(1100)}</svg>`;
    const r = parses(deep);
    expect((r as SvgFailure).error.code).toBe("limit");
    const ok = parses(`<svg>${"<g>".repeat(1000)}${"</g>".repeat(1000)}</svg>`);
    expect(ok).not.toBeInstanceOf(SvgFailure);
    let laughs = "<!DOCTYPE svg [<!ENTITY l0 'lol'>";
    for (let k = 1; k < 10; k++) laughs += `<!ENTITY l${k} '${`&l${k - 1};`.repeat(10)}'>`;
    laughs += "]><svg>&l9;</svg>";
    expect((parses(laughs) as SvgFailure).error.code).toBe("parse");
  });
});
