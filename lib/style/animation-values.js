// WebKit's historic animation properties are aliases, not expando properties.
export function animationProperty(name) {
  name = String(name);
  if(name.startsWith("--"))return name;
  if (/^webkitAnimation(?:[A-Z]|$)/.test(name)) name = name.slice(6);
  name = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  return name.replace(/^-webkit-(animation(?:-|$))/, '$1').replace(/^-animation/, 'animation');
}

export function animationLists(value) {
  return String(value).split(/,(?![^()]*\))/).map(value => value.trim());
}

export function animationShorthand(value) {
  return animationLists(value).map(source => {
    const result = {name:'none', duration:'0s', delay:'0s', iterationCount:'1', direction:'normal', fillMode:'none', playState:'running', timingFunction:'ease'};
    let times = 0;
    for (const token of source.match(/(?:[^\s(]+\([^)]*\)|[^\s]+)/g) ?? []) {
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
