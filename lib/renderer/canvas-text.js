import { parseFontShorthand } from "../style/computed-style.js";

const STRETCH = { "ultra-condensed": 50, "extra-condensed": 62.5, condensed: 75, "semi-condensed": 87.5,
  normal: 100, "semi-expanded": 112.5, expanded: 125, "extra-expanded": 150, "ultra-expanded": 200 };
const SIZES = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48 };

export function parseCanvasFont(value, base = 16, root = 16) {
  const font = parseFontShorthand(String(value));
  if (!font) return null;
  const size = font.size.toLowerCase();
  const length = size.match(/^(\d*\.?\d+)(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|%)$/);
  const factors = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6,
    em: base, rem: root, ex: base / 2, ch: base / 2, "%": base / 100 };
  const fontSize = SIZES[size] ?? (size === "larger" ? base * 1.2 : size === "smaller" ? base / 1.2
    : length ? Number(length[1]) * factors[length[2]] : NaN);
  if (!Number.isFinite(fontSize) || fontSize <= 0) return null;
  const fontFamily = font.family.match(/(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,])+/g)?.map(family => family.trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"));
  if (!fontFamily?.length || fontFamily.some(family => !family)) return null;
  return { fontSize, fontFamily, fontWeight: font.weight === "bold" ? 700 : Number(font.weight) || 400,
    fontStyle: font.style, fontStretch: STRETCH[font.stretch] ?? 100 };
}

/** Draw with the same shaped fonts, fallbacks and Unicode handling as DOM text. */
export function createCanvasTextRenderer(CanvasKit, makeParagraph) {
  const paragraphs = new Map();
  let characters = 0;
  const render = request => canvasText(CanvasKit, makeParagraph, request, {
    get(key) {
      const entry = paragraphs.get(key);
      if (entry) { paragraphs.delete(key); paragraphs.set(key, entry); }
      return entry?.paragraph;
    },
    set(key, paragraph, count) {
      paragraphs.set(key, { paragraph, count });
      characters += count;
      while (paragraphs.size > 128 || characters > 16000) {
        const [old, entry] = paragraphs.entries().next().value;
        entry.paragraph.delete(); characters -= entry.count; paragraphs.delete(old);
      }
    },
  });
  render.clear = () => {
    for (const { paragraph } of paragraphs.values()) paragraph.delete();
    paragraphs.clear(); characters = 0;
  };
  return render;
}

function canvasText(CanvasKit, makeParagraph, { context, canvas, settings, style, operation, args, paintStyle }, cache) {
  const text = String(args[0]).replace(/[\t\n\f\r]/g, " ");
  const stroke = operation === "strokeText";
  const measure = operation === "measureText";
  // CanvasKit's strokeStyle getter serializes every style as a color. The
  // context facade supplies its already-unwrapped gradient/pattern directly.
  const color = paintStyle ?? (stroke ? context.strokeStyle : context.fillStyle);
  const retained = text.length <= 4096 && (measure || typeof color === "string");
  const key = retained ? JSON.stringify([text, style, measure ? "measure" : [stroke, color, context.globalAlpha,
    context.globalCompositeOperation, context.lineWidth, context.miterLimit, context.lineJoin]]) : null;
  let paint, paragraph = retained ? cache.get(key) : null;
  let owned = !paragraph;
  try {
    if (!paragraph && !measure) {
      paint = new CanvasKit.Paint();
      paint.setAntiAlias(true);
      if (typeof color === "string") {
        const rgba = CanvasKit.parseColorString(color);
        rgba[3] *= context.globalAlpha;
        paint.setColor(rgba);
      } else if (typeof color?.pe === "function") {
        paint.setShader(color.pe(canvas.getTotalMatrix()));
        paint.setColor(CanvasKit.Color(0, 0, 0, context.globalAlpha));
      }
      if (stroke) {
        paint.setStyle(CanvasKit.PaintStyle.Stroke);
        paint.setStrokeWidth(context.lineWidth);
        paint.setStrokeMiter(context.miterLimit);
        paint.setStrokeJoin({ round: CanvasKit.StrokeJoin.Round, bevel: CanvasKit.StrokeJoin.Bevel }[context.lineJoin] ?? CanvasKit.StrokeJoin.Miter);
      }
      const blends = { "source-over": "SrcOver", "source-in": "SrcIn", "source-out": "SrcOut", "source-atop": "SrcATop",
        "destination-over": "DstOver", "destination-in": "DstIn", "destination-out": "DstOut", "destination-atop": "DstATop",
        lighter: "Plus", copy: "Src", xor: "Xor", multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken",
        lighten: "Lighten", "color-dodge": "ColorDodge", "color-burn": "ColorBurn", "hard-light": "HardLight", "soft-light": "SoftLight",
        difference: "Difference", exclusion: "Exclusion", hue: "Hue", saturation: "Saturation", color: "Color", luminosity: "Luminosity" };
      paint.setBlendMode(CanvasKit.BlendMode[blends[context.globalCompositeOperation] ?? "SrcOver"]);
    }
    if (!paragraph) {
      paragraph = makeParagraph(text, style, undefined, 1, paint);
      paragraph.layout(1e7);
      if (retained) { cache.set(key, paragraph, text.length); owned = false; }
    }
    const width = paragraph.getMaxIntrinsicWidth();
    const line = paragraph.getLineMetrics()[0];
    const alphabetic = paragraph.getAlphabeticBaseline();
    const ascent = line?.ascent ?? alphabetic, descent = line?.descent ?? paragraph.getHeight() - alphabetic;
    const baseline = { top: 0, hanging: alphabetic - ascent * 0.8, middle: (alphabetic - ascent + alphabetic + descent) / 2,
      alphabetic, ideographic: paragraph.getIdeographicBaseline(), bottom: alphabetic + descent }[settings.textBaseline] ?? alphabetic;
    let align = settings.textAlign;
    if (align === "start") align = settings.direction === "rtl" ? "right" : "left";
    if (align === "end") align = settings.direction === "rtl" ? "left" : "right";
    const offset = align === "center" ? width / 2 : align === "right" ? width : 0;
    if (measure) return { width, actualBoundingBoxLeft: offset, actualBoundingBoxRight: width - offset,
      actualBoundingBoxAscent: baseline - (alphabetic - ascent), actualBoundingBoxDescent: alphabetic + descent - baseline,
      fontBoundingBoxAscent: baseline, fontBoundingBoxDescent: paragraph.getHeight() - baseline,
      emHeightAscent: ascent, emHeightDescent: descent, hangingBaseline: alphabetic - ascent * 0.8,
      alphabeticBaseline: alphabetic - baseline, ideographicBaseline: paragraph.getIdeographicBaseline() - baseline };
    const [x, y] = args.slice(1, 3).map(Number);
    const maxWidth = args.length > 3 ? Number(args[3]) : Infinity;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(maxWidth > 0) || !text) return;
    const scale = width > maxWidth ? maxWidth / width : 1;
    canvas.save();
    try {
      canvas.translate(x - offset * scale, y - baseline);
      canvas.scale(scale, 1);
      canvas.drawParagraph(paragraph, 0, 0);
    } finally { canvas.restore(); }
  } finally {
    if (owned) paragraph?.delete();
    paint?.delete();
  }
}
