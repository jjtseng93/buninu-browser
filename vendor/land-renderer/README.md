# Buninu Land renderer

The renderer and its runtime dependencies are copied **unchanged** from
`buninu-land` commit `3a42a5e315b351aa1e70459133df50541d5368e3` (MIT).

Browser integration belongs in `lib/paint/direct-canvas.ts`, not in these
vendored files. That adapter presents browser RGBA layers as Land surfaces;
the compositor's channel-symmetric arithmetic preserves RGBA when supplied
with an opaque RGBA background surface. No red/blue conversion is needed.

`direct-compositor.ts` is the shared composition engine, including placement,
cropping, scaling, opacity detection, geometry/word caches and occlusion.
`renderer.ts` and its encoding/transport dependencies are included intact;
browser screenshots retain the browser's existing CDP/encoding owner.
