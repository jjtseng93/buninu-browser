import { expect, test } from "bun:test";
import {
  decodeHTML,
  decodeHTMLAttribute,
  decodeXML,
  escapeText,
} from "../lib/happy-dom/entities-adapter.js";

test("decodes HTML named and numeric character references with Bun.markdown", () => {
  expect(decodeHTML("Tom &amp; Jerry &copy; &#20013;&#x6587; &#x1F600;")).toBe(
    "Tom & Jerry © 中文 😀",
  );
  expect(decodeHTML("two code points: &NotEqualTilde;")).toBe("two code points: ≂̸");
  expect(decodeHTML("unknown: &buninu;")).toBe("unknown: &buninu;");
});

test("uses the same decoder for HTML attributes", () => {
  expect(decodeHTMLAttribute("search?a=1&amp;b=2&copy;=yes")).toBe(
    "search?a=1&b=2©=yes",
  );
});

test("keeps XML named references restricted to the XML predefined set", () => {
  expect(decodeXML("&lt;x a=&quot;y&quot;&gt;&amp;&apos;&#x1F600;&lt;/x&gt;")).toBe(
    `<x a="y">&'😀</x>`,
  );
  expect(decodeXML("&copy;")).toBe("&copy;");
});

test("escapes text without escaping ordinary quotes", () => {
  expect(escapeText(`Tom & Jerry <said> "hello"\u00A0`)).toBe(
    `Tom &amp; Jerry &lt;said&gt; "hello"&nbsp;`,
  );
});

test("Happy DOM uses the project entity adapter", async () => {
  const utilityPath =
    "../vendor/happy-dom/packages/happy-dom/src/utilities/XMLEncodeUtility.ts";
  const { default: XMLEncodeUtility } = await import(utilityPath);
  expect(XMLEncodeUtility.decodeHTMLEntities("CJK &#x4E2D; emoji &#x1F600;")).toBe(
    "CJK 中 emoji 😀",
  );
});
