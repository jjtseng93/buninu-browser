import SelectorParser from '../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorParser.ts';

// Unknown pseudo-classes are invalid selectors, not valid selectors with no
// matches. Libraries such as jQuery rely on that distinction to fall back to
// their own :visible/:hidden/:first implementations.
const simple = new Set(`active any-link autofill blank checked default defined disabled empty enabled first-child first-of-type focus focus-visible focus-within fullscreen future host hover in-range indeterminate invalid last-child last-of-type left link local-link modal only-child only-of-type open optional out-of-range past paused picture-in-picture popover-open placeholder-shown playing read-only read-write required right root scope target target-within user-invalid user-valid valid visited before after first-line first-letter`.split(' '));
const functional = new Set(`dir has host host-context is lang not nth-child nth-last-child nth-of-type nth-last-of-type state where`.split(' '));
const parsePseudo = SelectorParser.prototype.getPseudo;

function branches(text) {
  const result=[];let start=0,depth=0,quote='';
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='\\'){i++;continue;}
    if(quote){if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(c==='('||c==='[')depth++;
    else if(c===')'||c===']')depth--;
    else if(c===','&&!depth){result.push(text.slice(start,i));start=i+1;}
  }
  result.push(text.slice(start));return result;
}

SelectorParser.prototype.getPseudo = function(name,args) {
  const lower=name.toLowerCase();
  if (!(args == null ? simple : functional).has(lower)) {
    throw new this.window.DOMException(`Unknown or invalid pseudo-class :${name}`, 'SyntaxError');
  }
  // :is() and :where() have forgiving lists. Discard an invalid branch,
  // including its negations, rather than letting :not(:unknown) match all.
  if (lower==='is'||lower==='where') {
    const valid=[];
    for(const branch of branches(args??'')) {
      if(!branch.trim())continue;
      try{this.getSelectorGroups(branch);valid.push(branch);}catch(error){
        if(!(error instanceof this.window.DOMException))throw error;
      }
    }
    if(!valid.length)return parsePseudo.call(this,name,':not(*)');
    args=valid.join(',');
  }
  return parsePseudo.call(this,name,args);
};
