import { describe, expect, it } from "vitest";
import { Fragment, raw, SafeHtml } from "./jsx-runtime.js";

describe("jsx runtime", () => {
  it("renders a plain element with attributes and text children", () => {
    const el = <div className="x" id="y">hello</div>;
    expect(el).toBeInstanceOf(SafeHtml);
    expect(el.toString()).toBe('<div class="x" id="y">hello</div>');
  });

  it("escapes string children to prevent injection", () => {
    const el = <p>{'<script>alert(1)</script>'}</p>;
    expect(el.toString()).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it("passes raw() HTML through unescaped via SafeHtml children", () => {
    const el = <div>{raw("<b>bold</b>")}</div>;
    expect(el.toString()).toBe('<div><b>bold</b></div>');
  });

  it("emits void elements without a closing tag", () => {
    const el = <br />;
    expect(el.toString()).toBe('<br>');
  });

  it("renders boolean attributes as bare names when true", () => {
    const el = <input type="checkbox" checked />;
    expect(el.toString()).toBe('<input type="checkbox" checked>');
  });

  it("omits boolean attributes when false / null / undefined", () => {
    const el = <button disabled={false} aria-hidden={null}>x</button>;
    expect(el.toString()).toBe('<button>x</button>');
  });

  it("renders a Fragment as just its children's HTML", () => {
    const el = <><span>a</span><span>b</span></>;
    expect(el.toString()).toBe('<span>a</span><span>b</span>');
  });

  it("supports function components returning SafeHtml", () => {
    function Greet({ name }: { name: string }): SafeHtml {
      return <p>Hello {name}</p>;
    }
    const el = <Greet name="world" />;
    expect(el.toString()).toBe('<p>Hello world</p>');
  });
});
