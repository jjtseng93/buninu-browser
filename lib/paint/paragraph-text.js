// SkParagraph can shape a whole text run in one call. Only emoji need a
// different fallback order; ordinary text must stay together for shaping.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const hasEmojiPresentation = /\p{Emoji_Presentation}|\uFE0F/u;
const startsEmojiPresentation = /^\p{Emoji_Presentation}/u;

/** Append text with the emoji font preference applied to entire graphemes. */
export function appendParagraphText(builder, text, emojiStyle) {
  text ||= " ";
  if (!hasEmojiPresentation.test(text)) {
    builder.addText(text);
    return;
  }
  let start = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    if (!startsEmojiPresentation.test(segment) && !segment.includes("\uFE0F")) continue;
    if (index > start) builder.addText(text.slice(start, index));
    builder.pushStyle(emojiStyle());
    builder.addText(segment);
    builder.pop();
    start = index + segment.length;
  }
  if (start < text.length) builder.addText(text.slice(start));
}
