// Live demos: a demo with data-cycle swaps the name of its icons every 2 s while it is on screen.
(function () {
  'use strict';
  var demos = document.querySelectorAll('.demo[data-cycle]');
  if (!demos.length) return;
  demos.forEach(function (box) {
    var names = box.getAttribute('data-cycle').split(',');
    if (names.length < 2) return;
    var i = 0;
    var timer = 0;
    function step() {
      i = (i + 1) % names.length;
      box.querySelectorAll('morph-icon').forEach(function (m) { m.setAttribute('name', names[i]); });
    }
    function start() { if (!timer) timer = setInterval(step, 2000); }
    function stop() { clearInterval(timer); timer = 0; }
    box.querySelectorAll('morph-icon').forEach(function (m) { m.setAttribute('name', names[0]); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { e.isIntersecting ? start() : stop(); }); }).observe(box);
    } else start();
  });
})();
