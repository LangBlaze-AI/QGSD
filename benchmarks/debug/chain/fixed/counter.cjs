'use strict';

function f(a, b, c) {
  return a.filter(function(x) { return x >= b && x <= c; }).length;
}
module.exports = { f };
