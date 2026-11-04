// Use manifest totals from the same upstream revision as the run.
const [reportPath, totalsPath] = process.argv.slice(2);
if(!reportPath)throw Error('Usage: bun test/wpt/summarize.js REPORT.json [MANIFEST-TOTALS.json]');
const report=await Bun.file(reportPath).json();
const groups={};
for(const row of report.results){
  const group=groups[row.group]??={attempted:0,unsupported:0,pass:0,nonpass:0,subtests:0,passedSubtests:0};
  group.attempted++;
  if(row.classification==='unsupported-infrastructure'){group.unsupported++;continue;}
  group[row.classification==='pass'?'pass':'nonpass']++;
  group.subtests+=row.results.length;group.passedSubtests+=row.results.filter(t=>t.status===0).length;
}
const result={revision:report.revision,browserRevision:report.browserRevision,summary:report.summary,groups};
if(totalsPath){
  if(!report.officialManifest)throw Error('Whole-suite percentages require a run selected using an official manifest');
  const totals=await Bun.file(totalsPath).json();
  if(totals.revision!==report.revision)throw Error('Manifest and run WPT revisions differ');
  const total=Object.values(totals.types).reduce((n,t)=>n+t.cases,0);
  result.overall={totalManifestCases:total,verifiedPassingCases:report.summary.fullyPassingFiles,
    verifiedPassPercent:100*report.summary.fullyPassingFiles/total,
    attemptedCoveragePercent:100*report.results.length/total,
    meaning:'Verified lower bound, not an estimate of untested support; includes manual/visual cases in the denominator.',types:totals.types};
}
console.log(JSON.stringify(result,null,2));
