'use strict';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Addresses are multi-line and print with line breaks. Escaping first and
 * inserting the <br> afterwards keeps the only unescaped output in the app
 * to markup we generated ourselves.
 */
function nl2br(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

module.exports = { escapeHtml, nl2br };
