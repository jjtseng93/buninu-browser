// Count cases from an official WPT manifest; support files are not tests.
const [manifestPath, root='../wpt'] = process.argv.slice(2);
if(!manifestPath)throw Error('Usage: bun test/wpt/count-manifest.js MANIFEST.json [WPT_ROOT]');
const manifest=await Bun.file(manifestPath).json();
const command=Bun.spawn(['git','-C',root,'rev-parse','HEAD'],{stdout:'pipe',stderr:'pipe'});
const revision=(await new Response(command.stdout).text()).trim();
if(await command.exited)throw Error('Cannot read WPT revision');
const types={};
for(const [type,tree]of Object.entries(manifest.items)){
  if(['support','spec'].includes(type))continue;
  const counts=types[type]={files:0,cases:0};
  const visit=node=>{
    if(Array.isArray(node)){counts.files++;counts.cases+=node.length-1;return;}
    for(const child of Object.values(node))visit(child);
  };
  visit(tree);
}
console.log(JSON.stringify({revision,manifestVersion:manifest.version,types},null,2));
