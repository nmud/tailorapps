// The download bar slides up once the tour has shown three steps, and steps aside at the end
// where the page has its own download buttons.
(function () {
  var bar = document.querySelector('[data-sticky]');
  var third = document.querySelectorAll('.step')[2];
  var final = document.querySelector('.final');
  if (!bar || !third || !final || !('IntersectionObserver' in window)) return;

  var pastThird = false;
  var atEnd = false;
  function update() {
    bar.classList.toggle('is-visible', pastThird && !atEnd);
  }

  new IntersectionObserver(function (entries) {
    var e = entries[0];
    pastThird = e.isIntersecting || e.boundingClientRect.top < 0;
    update();
  }).observe(third);

  new IntersectionObserver(function (entries) {
    atEnd = entries[0].isIntersecting;
    update();
  }).observe(final);
})();
