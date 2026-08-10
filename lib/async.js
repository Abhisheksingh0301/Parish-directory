'use strict';

/**
 * Express 4 does not catch rejected promises from route handlers — an
 * unhandled rejection would hang the request instead of rendering the error
 * page. Wrap every async handler with this.
 */
module.exports = function wrap(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
};
