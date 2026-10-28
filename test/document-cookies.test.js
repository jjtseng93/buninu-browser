import { expect, test } from "bun:test";
import { CookieJar } from "../lib/network/cookie-jar.js";
import { DocumentCookies } from "../lib/renderer/document-cookies.js";

const url = "https://page.test/app/index.html";
const pairs = value => value.split("; ").filter(Boolean).sort();
function fixture() {
  let now = 100000, revision = 0;
  const sent = [], jar = new CookieJar({ now: () => now });
  const mirror = new DocumentCookies((value, url, sequence) => sent.push({ value, url, sequence }), () => now);
  const snapshot = (acknowledged = 0) => ({ revision: ++revision, acknowledged, cookies: jar.scriptSnapshot(url) });
  return { jar, mirror, sent, snapshot, advance: ms => { now += ms; } };
}

test("a delayed snapshot retains newer setters and unrelated server cookies, then acknowledges them", () => {
  const { jar, mirror, sent, snapshot } = fixture();
  jar.store(url, ["key=before; Path=/"]);
  mirror.accept(snapshot());
  mirror.set(url, "key=after; Path=/");
  jar.store(url, ["server=2; Path=/", "secret=hidden; Path=/; HttpOnly"]);
  const delayed = snapshot();
  expect(mirror.accept(delayed)).toBe(true);
  expect(pairs(mirror.get(url))).toEqual(["key=after", "server=2"]);
  expect(JSON.stringify(delayed)).not.toContain("secret");
  jar.store(sent[0].url, [sent[0].value], { fromScript: true });
  const acknowledged = snapshot(sent[0].sequence);
  mirror.accept(acknowledged);
  expect(pairs(mirror.get(url))).toEqual(pairs(jar.documentCookie(url)));
  expect(mirror.accept(delayed)).toBe(false);
  expect(mirror.accept({ ...delayed, revision: acknowledged.revision + 1 })).toBe(false);
  expect(pairs(mirror.get(url))).toEqual(["key=after", "server=2"]);
  // Once acknowledged, a later server overwrite is authoritative.
  jar.store(url, ["key=server; Path=/"]);
  mirror.accept(snapshot(sent[0].sequence));
  expect(pairs(mirror.get(url))).toEqual(["key=server", "server=2"]);
});

test("pending setters and deletions retain cookie Path, Domain, and Secure rules", () => {
  const { jar, mirror, snapshot } = fixture();
  jar.store(url, ["key=root; Path=/", "key=app; Path=/app", "parent=1; Domain=page.test; Path=/"]);
  mirror.accept(snapshot());
  mirror.set(url, "key=new; Path=/app");
  mirror.set(url, "rejected=1; Domain=other.test");
  mirror.accept(snapshot());
  expect(pairs(mirror.get(url))).toEqual(["key=new", "key=root", "parent=1"]);
  expect(pairs(mirror.get("https://page.test/other"))).toEqual(["key=root", "parent=1"]);
  expect(mirror.get("https://sub.page.test/app/")).toBe("parent=1");
  mirror.set(url, "key=; Path=/app; Max-Age=0");
  jar.store(url, ["unrelated=3; Path=/"]);
  mirror.accept(snapshot());
  expect(pairs(mirror.get(url))).toEqual(["key=root", "parent=1", "unrelated=3"]);
  mirror.set("http://page.test/app/", "secure=1; Secure; Path=/");
  expect(mirror.get(url)).not.toContain("secure=");
});

test("replaying an unacknowledged Max-Age cookie does not restart its lifetime", () => {
  const { mirror, snapshot, advance } = fixture();
  mirror.accept(snapshot());
  mirror.set(url, "short=1; Max-Age=2; Path=/");
  advance(1500);
  mirror.accept(snapshot());
  expect(mirror.get(url)).toBe("short=1");
  advance(600);
  mirror.accept(snapshot());
  expect(mirror.get(url)).toBe("");
});

test("snapshot records exclude HttpOnly and unrelated hosts and cannot share mutable jar records", () => {
  const { jar } = fixture();
  jar.store(url, ["public=1; Path=/", "private=secret; Path=/; HttpOnly", "path=1; Path=/elsewhere"]);
  jar.store("https://other.test/", ["other=secret; Path=/"]);
  const records = jar.scriptSnapshot(url);
  expect(records.map(cookie => cookie.name).sort()).toEqual(["path", "public"]);
  records[0].value = "changed";
  expect(jar.documentCookie(url)).toBe("public=1");
  const mirror = new CookieJar();
  mirror.replaceScriptSnapshot(records);
  records[0].value = "changed again";
  expect(mirror.documentCookie(url)).toBe("public=changed");
});

test("legacy string-only embedders retain replacement semantics", () => {
  const mirror = new DocumentCookies();
  mirror.seed(url, "first=1; second=2");
  expect(pairs(mirror.get(url))).toEqual(["first=1", "second=2"]);
  mirror.seed(url, "second=3", true);
  expect(mirror.get(url)).toBe("second=3");
  mirror.seed(url, "", true);
  expect(mirror.get(url)).toBe("");
  mirror.seed(url, "id=app; id=root; other=1", true);
  expect(mirror.get(url)).toBe("id=app; id=root; other=1");
  mirror.set(url, "other=2; Path=/");
  expect(mirror.get(url)).toBe("id=app; id=root; other=2");
  mirror.set(url, "id=; Max-Age=0");
  expect(mirror.get(url)).toBe("other=2");
});

test("unacknowledged legacy setters do not replay after the snapshot protocol is established", () => {
  const { mirror, snapshot } = fixture();
  for (let i = 0; i < 1000; i++) mirror.set(url, `legacy=${i}; Path=/`);
  expect(mirror.get(url)).toBe("legacy=999");
  mirror.accept(snapshot());
  expect(mirror.get(url)).toBe("");
});

test("an HttpOnly overwrite is rejected by the controller without exposing its value", () => {
  const { jar, mirror, sent, snapshot } = fixture();
  jar.store(url, ["private=hidden; HttpOnly; Path=/", "public=visible; Path=/"]);
  mirror.accept(snapshot());
  mirror.set(url, "private=attempted; Path=/");
  jar.store(sent[0].url, [sent[0].value], { fromScript: true });
  const state = snapshot(sent[0].sequence);
  expect(JSON.stringify(state)).not.toContain("hidden");
  mirror.accept(state);
  expect(mirror.get(url)).toBe("public=visible");
  expect(jar.header(url)).toBe("private=hidden; public=visible");
});
