import { describe, expect, it } from "vitest";

import {
  lint,
  MissingVariableError,
  render,
  renderMessages,
  templateVariables,
  TemplateParseError,
  TemplateRenderError,
} from "../src/index.js";

/** Behaviour beyond the conformance cases, and the parts a Node app is most likely to hit. */

describe("render", () => {
  it("returns the source verbatim under the raw engine", () => {
    const source = "{% include \"x\" %} {{ a";
    expect(render(source, { a: 1 }, "raw")).toBe(source);
  });

  it("keeps whitespace that is not the whole body of a block", () => {
    expect(render("a {% if x %} b {% endif %}c", { x: true })).toBe("a  b c");
  });

  it("drops a block body that is nothing but whitespace", () => {
    expect(render("[{% if x %}   {% endif %}]", { x: true })).toBe("[]");
  });

  it("keeps an assign made inside a loop after the loop", () => {
    expect(render("{% for i in xs %}{% assign last = i %}{% endfor %}{{ last }}", { xs: [1, 2] })).toBe(
      "2",
    );
  });

  it("supports nested loops with their own forloop", () => {
    const out = render(
      "{% for row in rows %}{% for cell in row %}{{ forloop.index }}{{ cell }}{% endfor %};{% endfor %}",
      { rows: [["a", "b"], ["c"]] },
    );
    expect(out).toBe("1a2b;1c;");
  });

  it("reports the dotted path of a missing nested variable", () => {
    expect(() => render("{{ a.b.c }}", { a: { b: {} } })).toThrowError(MissingVariableError);
    try {
      render("{{ a.b.c }}", { a: { b: {} } });
    } catch (error) {
      expect((error as MissingVariableError).variable).toBe("a.b.c");
    }
  });

  it("treats a present null as defined", () => {
    expect(render("[{{ x }}]", { x: null })).toBe("[]");
    expect(render("{{ x | default: \"fb\" }}", { x: null })).toBe("fb");
  });

  it("refuses a filter outside the subset at render time", () => {
    expect(() => render("{{ s | upcase }}", { s: "a" })).toThrowError(TemplateRenderError);
  });

  it("refuses a tag outside the subset at parse time", () => {
    expect(() => render("{% tablerow x in y %}{% endtablerow %}", {})).toThrowError(
      TemplateParseError,
    );
  });

  it("renders a range loop", () => {
    expect(render("{% for i in (1..3) %}{{ i }}{% endfor %}", {})).toBe("123");
  });

  it("honours limit, offset and reversed on a for tag", () => {
    const items = { xs: ["a", "b", "c", "d"] };
    expect(render("{% for i in xs limit: 2 %}{{ i }}{% endfor %}", items)).toBe("ab");
    expect(render("{% for i in xs offset: 2 %}{{ i }}{% endfor %}", items)).toBe("cd");
    expect(render("{% for i in xs reversed %}{{ i }}{% endfor %}", items)).toBe("dcba");
  });

  it("renders messages and leaves every other key alone", () => {
    const rendered = renderMessages(
      [
        { role: "system", content: "Hi {{ name }}", name: "greeter" },
        { role: "user", content: "plain" },
      ],
      { name: "Ada" },
    );
    expect(rendered).toEqual([
      { role: "system", content: "Hi Ada", name: "greeter" },
      { role: "user", content: "plain" },
    ]);
  });
});

describe("lint", () => {
  it("accepts the whole allowed subset", () => {
    expect(lint("{% assign a = 1 %}{% if a %}{{ a | size }}{% endif %}")).toEqual({ ok: true });
  });

  it("names every disallowed tag it finds", () => {
    const result = lint("{% capture a %}{% endcapture %}{% cycle 1 %}");
    expect(result).toEqual({
      ok: false,
      reasons: [
        { kind: "disallowed_tag", value: "capture" },
        { kind: "disallowed_tag", value: "endcapture" },
        { kind: "disallowed_tag", value: "cycle" },
      ],
    });
  });
});

describe("templateVariables", () => {
  it("reads the root of every referenced path", () => {
    expect(templateVariables("{{ a.b }}{% for x in items %}{{ x }}{% endfor %}{{ c | join: d }}")).toEqual(
      ["a", "c", "d", "items"],
    );
  });

  it("falls back to a scrape when the template does not parse", () => {
    expect(templateVariables("{% if a %}{{ b }}")).toEqual(["a", "b"]);
  });
});
