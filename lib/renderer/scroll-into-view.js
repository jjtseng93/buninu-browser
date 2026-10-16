/** CSSOM View's boolean/dictionary overload and logical alignment options. */
export function scrollIntoViewOptions(value = undefined) {
  const dictionary = value !== null && (typeof value === "object" || typeof value === "function") ? value : {};
  const { block: requestedBlock = "start", inline = "nearest", behavior = "auto", container = "all" } = dictionary;
  const block = value !== null && value !== undefined && typeof value !== "object" && typeof value !== "function"
    ? (Boolean(value) ? "start" : "end") : requestedBlock;
  const options = {
    block: String(block), inline: String(inline), behavior: String(behavior), container: String(container),
  };
  for (const key of ["block", "inline"]) {
    if (!["start", "center", "end", "nearest"].includes(options[key])) throw new TypeError(`Invalid scrollIntoView ${key}`);
  }
  if (!["auto", "instant", "smooth"].includes(options.behavior)) throw new TypeError("Invalid scrollIntoView behavior");
  if (!["all", "nearest"].includes(options.container)) throw new TypeError("Invalid scrollIntoView container");
  return options;
}

/** Signed scroll distance for one axis, with the target relative to the scrollport. */
export function scrollAlignmentDelta(start, size, viewportSize, alignment) {
  const end = start + size;
  if (alignment === "start") return start;
  if (alignment === "end") return end - viewportSize;
  if (alignment === "center") return start + (size - viewportSize) / 2;
  // Nearest leaves both fully visible and viewport-spanning boxes alone.
  if ((start >= 0 && end <= viewportSize) || (start <= 0 && end >= viewportSize)) return 0;
  const endDelta = end - viewportSize;
  return Math.abs(start) < Math.abs(endDelta) ? start : endDelta;
}
