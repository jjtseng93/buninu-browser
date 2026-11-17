// A separate Bun process builds bytecode; QML component creation is synchronous.
const [input, outdir] = process.argv.slice(2);
const result = await Bun.build({entrypoints:[input],outdir,naming:'factory.cjs',target:'bun',format:'cjs',bytecode:true});
if (!result.success) { console.error(result.logs.join('\n')); process.exitCode=1; }
