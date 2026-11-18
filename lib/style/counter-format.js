export const symbolicCounterStyles = new Map([
  ["disc","•"], ["circle","◦"], ["square","▪"], ["disclosure-closed","▶"], ["disclosure-open","▼"],
]);
export const builtinCounterStyles = new Set(["none","decimal","decimal-leading-zero","lower-alpha","upper-alpha",
  "lower-latin","upper-latin","lower-roman","upper-roman", ...symbolicCounterStyles.keys()]);

export function formatCounter(type, value) {
  switch (type) {
    case "none": return "";
    case "decimal-leading-zero": return String(value).padStart(2,"0");
    case "lower-alpha": case "lower-latin": return alphabetic(value);
    case "upper-alpha": case "upper-latin": return alphabetic(value).toUpperCase();
    case "lower-roman": return roman(value);
    case "upper-roman": return roman(value).toUpperCase();
    default: return symbolicCounterStyles.get(type) ?? String(value);
  }
}

function alphabetic(value) {
  let text = "";
  for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    text = String.fromCharCode(97 + (rest - 1) % 26) + text;
  }
  return text || String(value);
}

function roman(value) {
  if (value <= 0 || value >= 4000) return String(value);
  const numerals = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let text = "";
  for (const [amount, numeral] of numerals) {
    while (value >= amount) {
      text += numeral;
      value -= amount;
    }
  }
  return text;
}
