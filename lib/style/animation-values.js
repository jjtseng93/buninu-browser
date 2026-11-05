// WebKit's historic animation properties are aliases, not expando properties.
export function animationProperty(name) {
  name = String(name);
  if(name.startsWith("--"))return name;
  if (/^webkitAnimation(?:[A-Z]|$)/.test(name)) name = name.slice(6);
  name = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  return name.replace(/^-webkit-(animation(?:-|$))/, '$1').replace(/^-animation/, 'animation');
}

export function animationLists(value) {
  return splitAnimationText(value, ',');
}

// Commas and spaces inside easing math or quoted animation names belong to a
// single component. A one-parenthesis regex splits nested min()/calc() calls.
function splitAnimationText(value,separator) {
  const source=String(value),parts=[];
  let depth=0,quote='',start=0;
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(c==='\\'){i++;continue;}
    if(quote){if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(c==='/'&&source[i+1]==='*') {
      const end=source.indexOf('*/',i+2);
      if(end<0)break;
      i=end+1;continue;
    }
    if(c==='(')depth++;
    else if(c===')')depth--;
    else if(depth===0&&(c===separator||separator===' '&&/[\t\n\r\f]/.test(c))) {
      parts.push(source.slice(start,i).trim());start=i+1;
    }
  }
  parts.push(source.slice(start).trim());return parts;
}

export function animationShorthand(value) {
  return animationLists(value).map(source => {
    const result = {name:'none', duration:'0s', delay:'0s', iterationCount:'1', direction:'normal', fillMode:'none', playState:'running', timingFunction:'ease'};
    let times = 0;
    for (const token of splitAnimationText(source,' ').filter(Boolean)) {
      if (/^-?(?:\d*\.)?\d+m?s$/.test(token)) result[times++ ? 'delay' : 'duration'] = token;
      else if (/^(infinite|(?:\d*\.)?\d+)$/.test(token)) result.iterationCount = token;
      else if (/^(normal|reverse|alternate|alternate-reverse)$/.test(token)) result.direction = token;
      else if (/^(forwards|backwards|both|none)$/.test(token)) result.fillMode = token;
      else if (/^(running|paused)$/.test(token)) result.playState = token;
      else if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(|steps\()/.test(token)) result.timingFunction = token;
      else result.name = token.replace(/^(['"])(.*)\1$/, '$2');
    }
    return result;
  });
}
