import { expect, test } from "bun:test";
import { fetchResolved, HostResolver, isLocalhostName } from "../lib/network/resolver.js";

const lookupFrom = (table, calls = []) => async (name, { family }) => {
  calls.push(`${name}/${family}`);
  const addresses = table[`${name}/${family}`];
  if (!addresses) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return addresses.map((address) => ({ address, family }));
};

test("looks each family up separately, IPv4 first, and caches for the TTL", async () => {
  const calls = [];
  let now = 0;
  const resolver = new HostResolver({
    lookup: lookupFrom({ "a.test/4": ["192.0.2.1"], "a.test/6": ["2001:db8::1"] }, calls), ttl: 1000, now: () => now,
  });
  expect(await resolver.addresses("A.test")).toEqual([
    { address: "192.0.2.1", family: 4 }, { address: "2001:db8::1", family: 6 },
  ]);
  await resolver.addresses("a.test");
  expect(calls).toEqual(["a.test/4", "a.test/6"]);
  now = 1001;
  await resolver.addresses("a.test");
  expect(calls).toHaveLength(4);
  // One family missing is fine; none is an error that is not cached.
  const v6only = new HostResolver({ lookup: lookupFrom({ "b.test/6": ["2001:db8::2"] }) });
  expect(await v6only.addresses("b.test")).toEqual([{ address: "2001:db8::2", family: 6 }]);
  await expect(v6only.addresses("c.test")).rejects.toThrow("Unable to resolve c.test");
});

test("connects to the address with the host name in Host and TLS, falling back on connect errors", async () => {
  const resolver = new HostResolver({ lookup: lookupFrom({ "a.test/4": ["192.0.2.1"], "a.test/6": ["2001:db8::1"] }) });
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, host: new Headers(init.headers).get("host"), serverName: init.tls?.serverName });
    if (url.includes("192.0.2.1")) throw Object.assign(new Error("refused"), { code: "ConnectionRefused" });
    return new Response("ok");
  };
  const response = await fetchResolved(fakeFetch, resolver, "https://a.test:8443/p?q=1", { headers: { accept: "*/*" } });
  expect(await response.text()).toBe("ok");
  expect(seen).toEqual([
    { url: "https://192.0.2.1:8443/p?q=1", host: "a.test:8443", serverName: "a.test" },
    { url: "https://[2001:db8::1]:8443/p?q=1", host: "a.test:8443", serverName: "a.test" },
  ]);
  // IP literals are not resolved; other errors are not retried.
  seen.length = 0;
  await fetchResolved(fakeFetch, resolver, "http://[::1]/", {});
  expect(seen[0].url).toBe("http://[::1]/");
  const failing = async () => { throw Object.assign(new Error("bad cert"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }); };
  await expect(fetchResolved(failing, resolver, "https://a.test/", {})).rejects.toThrow("bad cert");
});

test("localhost names are loopback without a lookup (no /etc/hosts needed)", async () => {
  const resolver = new HostResolver({ lookup: async () => { throw Object.assign(new Error("no hosts"), { code: "ENOTFOUND" }); } });
  const loopback = [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }];
  for (const name of ["localhost", "LocalHost", "localhost.", "app.localhost", "a.b.localhost."]) {
    expect(await resolver.addresses(name)).toEqual(loopback);
  }
  for (const name of ["localhost.com", "notlocalhost", "localhost..", "my-localhost"]) {
    expect(isLocalhostName(name)).toBe(false);
  }
});
