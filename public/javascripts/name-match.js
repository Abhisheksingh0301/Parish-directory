/**
 * Does the name somebody typed mean the name on record?
 *
 * Asked in exactly one place: the confirmation on a destructive action, where
 * the office types its parish name to show it knows which parish it is about
 * to empty.
 *
 * ── Why this file is shaped oddly ──────────────────────────────────────────
 * It is loaded twice, by two different runtimes: `require`d by
 * routes/admin.js, which has the last word on whether the delete happens, and
 * fetched by the browser, which decides whether the button is enabled. Those
 * two have to agree. A browser that enables the button on a value the server
 * then refuses is worse than no button state at all — the office presses a
 * live-looking button and is told to type the name it just typed.
 *
 * A second copy of the rule in an inline script is how they come to disagree,
 * so there is one copy and both ends load it. Hence the wrapper below, which
 * is the only thing in public/javascripts/ that is not a plain IIFE.
 *
 * ── Why it forgives anything at all ────────────────────────────────────────
 * It used to compare the two strings exactly, and that made the confirmation
 * unsatisfiable for this Parish. Its name is on record as
 *
 *     St. Peter’s Mar Thoma Church        U+2019, a typographic apostrophe
 *
 * and the apostrophe on a keyboard is
 *
 *     St. Peter's Mar Thoma Church        U+0027, the straight one
 *
 * Those render almost identically at 15px, the placeholder showed the first,
 * the office typed the second, and the button stayed dead with nothing on
 * screen to say why. No amount of care at the keyboard could have fixed it;
 * only pasting the name from somewhere else would have.
 *
 * So the characters that do not change what a name *means* are folded
 * together: the apostrophe and quote families, the dash family, runs of any
 * kind of space, and letter case. What is not forgiven is the name itself —
 * the office still has to know it and type it, which is the whole purpose of
 * asking. Folding a curly apostrophe into a straight one removes an obstacle;
 * it removes no safety, because nobody ever deleted the wrong parish by
 * getting an apostrophe right.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NameMatch = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* U+2018/2019 curly singles, U+02BC modifier, U+02B9 prime, U+00B4 acute,
     U+0060 backtick, U+FF07 full-width — everything a word processor, a phone
     keyboard or a paste from Word can put where an apostrophe belongs. */
  var APOSTROPHES = /[‘’ʼʹ´`＇]/g;

  /* U+201C/201D curly doubles, U+00AB/00BB guillemets, U+FF02 full-width. */
  var QUOTES = /[“”«»＂]/g;

  /* U+2010..U+2015 hyphen through horizontal bar, U+2212 minus, U+FF0D. */
  var DASHES = /[‐-―−－]/g;

  /* Any run of any whitespace, non-breaking space included — a name pasted
     out of a web page often carries one, and it is invisible. */
  var SPACES = /\s+/g;

  /**
   * The comparable form of a name. Not for storing or printing: the parish's
   * own spelling, apostrophe and all, is the correct one and stays on record.
   */
  function fold(text) {
    return text
      .replace(APOSTROPHES, "'")
      .replace(QUOTES, '"')
      .replace(DASHES, '-');
  }

  function normalise(value) {
    var text = value === null || value === undefined ? '' : String(value);

    /*
     * Folded before the compatibility pass as well as after it, which is not
     * belt-and-braces but necessary: NFKC decomposes the acute accent U+00B4
     * into a space and a combining mark, so a fold that ran only afterwards
     * would never see the character it was there to catch. Someone typing
     * "Peter´s" on a layout with a dead key means the apostrophe, and should
     * be understood.
     */
    text = fold(text);

    // Guarded because it is the one part of this an old browser may lack.
    if (typeof text.normalize === 'function') {
      try {
        text = text.normalize('NFKC');
      } catch (err) {
        /* Left as it was; every fold still applies. */
      }
    }

    return fold(text)
      .replace(SPACES, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Whether these two name the same thing.
   *
   * An empty typed value never matches, even against an empty name on record:
   * "press the button without typing anything" is the one case this exists to
   * prevent, and a church with no name is a bug elsewhere, not permission.
   */
  function same(typed, onRecord) {
    var a = normalise(typed);
    return a !== '' && a === normalise(onRecord);
  }

  return { normalise: normalise, same: same };
}));
