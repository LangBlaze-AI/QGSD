'use strict';

function f(a, b) {
  return a.filter(function(x) { return x > b; });
}
module.exports = { f };