import {test, expect} from "bun:test";
import {renderMinInterval, RENDER_INTERVAL_FLAG} from "../lib/renderer/render-interval.js";
import {RendererHost} from "../lib/renderer/host.js";

test("render interval validates boundaries without silently accepting malformed values", () => {
  for (const [value, expected] of [[undefined,16],["0",0],["8",8],["16",16],["60000",60000]]) {
    const warnings=[];expect(renderMinInterval(value,s=>warnings.push(s))).toBe(expected);expect(warnings).toEqual([]);
  }
  for (const value of ["","-1","60001","1.5","8ms","Infinity","NaN"," 8 "]) {
    const warnings=[];expect(renderMinInterval(value,s=>warnings.push(s))).toBe(16);expect(warnings.length).toBe(1);
  }
});

test("renderer receives configured interval on launch without inheriting host environment", async () => {
  const old=process.env.BUNINU_RENDER_MIN_INTERVAL, secret=process.env.BUNINU_TEST_PRIVATE_ENV;
  let host;
  try {
    process.env.BUNINU_TEST_PRIVATE_ENV="must-not-leak";
    for (const interval of ["8","0","60000"]) {
      process.env.BUNINU_RENDER_MIN_INTERVAL=interval;
      host=new RendererHost({entry:new URL("./fixtures/fake-renderer.js",import.meta.url).pathname});
      await host.start();
      const result=await host.call("configuration");
      expect(result.args).toContain(RENDER_INTERVAL_FLAG+interval);
      expect(result.secret).toBeUndefined();
      host.close();
    }
  } finally {
    host?.close();
    if(old===undefined)delete process.env.BUNINU_RENDER_MIN_INTERVAL;else process.env.BUNINU_RENDER_MIN_INTERVAL=old;
    if(secret===undefined)delete process.env.BUNINU_TEST_PRIVATE_ENV;else process.env.BUNINU_TEST_PRIVATE_ENV=secret;
  }
});
