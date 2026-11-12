import { describe, expect, it } from "vitest";
import { imageDoctypeIsInert } from "./svg-image-xml.js";

describe("SVG image DOCTYPE inertness (DM-1YAE1F)", () => {
  it.each([
    "<svg/>",
    "<!DOCTYPE svg><svg/>",
    '<?xml version="1.0"?><!-- c --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>',
    "<!DOCTYPE svg SYSTEM 'local.dtd'><svg/>",
    "<!DOCTYPE\tsvg\n><svg/>",
    "<svg><![CDATA[<!DOCTYPE]]><!-- <!x --></svg>",
  ])("admits %s", (xml) => {
    expect(imageDoctypeIsInert(xml)).toBe(true);
  });
  it.each([
    // Internal subsets declare entities and attribute defaults.
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    "<!DOCTYPE svg []><svg/>",
    // ExternalSubsetHandler turns on XHTML named entities for these public IDs.
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD XHTML 1.1//EN" "x.dtd"><svg/>',
    '<!DOCTYPE math PUBLIC "-//W3C//DTD MathML 2.0//EN" "x.dtd"><svg/>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD XHTML 1.1 plus MathML 2.0 plus SVG 1.1//EN" "x.dtd"><svg/>',
    // Shapes the strict grammar does not prove.
    "<!DOCTYPE svg><!DOCTYPE svg><svg/>",
    '<!DOCTYPE svg PUBLIC "only-public-id"><svg/>',
    "<svg/><!DOCTYPE svg>",
    "<!ENTITY x 'y'><svg/>",
    // XML names are case-sensitive; libxml2 rejects a lowercase doctype.
    "<!doctype svg><svg/>",
    "<!DOCTYPE svg",
  ])("refuses %s", (xml) => {
    expect(imageDoctypeIsInert(xml)).toBe(false);
  });
});
