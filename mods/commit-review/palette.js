// Colors for the diff, taken from the Herdr theme's ANSI colors, so they follow
// the person's theme in light and dark. The keys are highlight.js's classes,
// plus the tints of added and removed rows.

/** The color of each token class and row tint, for the theme `t` (theme()). */
export function palette(t) {
  return {
    keyword: t.ansi5,
    string: t.ansi2,
    comment: t.dim,
    number: t.ansi3,
    constant: t.ansi3,
    type: t.ansi6,
    function: t.ansi4,
    property: t.ansi4,
    added: t.ansi2,
    removed: t.ansi1,
  };
}
