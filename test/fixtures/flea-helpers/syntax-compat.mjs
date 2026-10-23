// jsmdcui 0.19.2's Micro rules contain Go regex flags/boundaries unsupported by JS.
// Adapt those rule objects locally; do not modify the installed npm package.
export function adaptSyntaxRules(definitions, SyntaxDefinition) {
 function compile(pattern, original) {
  if(typeof pattern!=='string'||!(/\(\?[ims]+\)|\\[<>]/.test(pattern)))return original;
  const flags=new Set();
  const source=pattern.replace(/\(\?([ims]+)\)/g,(_,letters)=>{for(const flag of letters)flags.add(flag);return '';})
   .replaceAll('\\<','\\b(?=\\w)').replaceAll('\\>','(?<=\\w)\\b');
  const regex=new SyntaxDefinition({}, {rules:[{compat:source}]}).rules[0]?.regex;
  if(!regex)return original;
  try{return new RegExp(regex.source,[...new Set([...regex.flags,...flags])].join(''));}catch{return original;}
 }
 function visit(rules) {
  for(const rule of rules){
   if(rule.type==='pattern')rule.regex=compile(rule.source,rule.regex);
   if(rule.type==='region'){
    for(const key of ['start','end','skip'])rule[key]=compile(rule.source?.[key],rule[key]);
    visit(rule.rules);
   }
  }
 }
 for(const definition of definitions)visit(definition.rules);
}
