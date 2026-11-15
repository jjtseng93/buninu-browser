import {expect, test} from 'bun:test';

// SES freezes intrinsics, so keep the test runner outside its realm.
test('SES import prefilter preserves rejection and explicit loader routing', () => {
  const bundle = new URL('../vendor/ses/dist/ses.mjs', import.meta.url).href;
  const child = Bun.spawnSync([process.execPath, '-e', `
    await import(${JSON.stringify(bundle)});
    lockdown({errorTaming:'unsafe'});
    const c = new Compartment({__import__: name => 'routed:' + name});
    const imports = ['import("x")', 'import\\u2028("x")',
      'import\\u2029("x")', 'import/*comment*/("x")', 'import //comment\\n("x")'];
    const result = imports.map(source => {
      let rejected = false;
      try { c.evaluate(source); }
      catch (e) { rejected = e.name === 'SyntaxError' && e.message.includes('SES_IMPORT_REJECTED'); }
      return [rejected, c.evaluate(source, {__evadeImportExpressionTest__:true})];
    });
    result.push(c.evaluate('1+2'));
    result.push(c.evaluate('"important"', {__evadeImportExpressionTest__:true}));
    result.push(c.evaluate('"IMPORT"', {__evadeImportExpressionTest__:true}));
    console.log(JSON.stringify(result));
  `], {stdout:'pipe', stderr:'pipe'});
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual([
    ...Array.from({length:5}, () => [true, 'routed:x']), 3, 'important', 'IMPORT',
  ]);
});
