(function () {
  'use strict';
  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var KEY = 'sn-mode';

  // Mode toggle: Bauhaus <-> Monochrome. The <head> script applies the saved mode before paint.
  var modeBtn = document.getElementById('mode');
  function syncMode() { modeBtn.setAttribute('aria-pressed', String(root.getAttribute('data-theme') === 'mono')); }
  syncMode();
  modeBtn.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'mono' ? 'bauhaus' : 'mono';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
    syncMode();
  });
  try { localStorage.removeItem('sn-theme'); } catch (e) {}

  // Scroll reveals, staggered within each batch that enters together.
  var reveals = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var revealer = new IntersectionObserver(function (entries) {
      var k = 0;
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.style.setProperty('--d', (k++ * 90) + 'ms');
        e.target.classList.add('in');
        revealer.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -12% 0px' });
    reveals.forEach(function (el) { revealer.observe(el); });
  }

  // Section emblems and the contact composition settle each time they come into view, and reset once fully out of it.
  var embs = document.querySelectorAll('.emb, .contact');
  if (reduce || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(embs, function (el) { el.classList.add('on'); });
  } else {
    var embWatch = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.intersectionRatio >= 0.6) e.target.classList.add('on');
        else if (!e.isIntersecting) e.target.classList.remove('on');
      });
    }, { threshold: [0, 0.6] });
    Array.prototype.forEach.call(embs, function (el) { embWatch.observe(el); });
  }

  // Active section in the nav.
  var links = {};
  Array.prototype.forEach.call(document.querySelectorAll('.nav a'), function (a) { links[a.hash.slice(1)] = a; });
  function setActive(id) {
    Object.keys(links).forEach(function (k) {
      if (k === id) links[k].setAttribute('aria-current', 'true');
      else links[k].removeAttribute('aria-current');
    });
  }
  // The contact band is too short to reach the middle of the viewport, so the page bottom counts as contact.
  var current = null;
  function atBottom() { return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4; }
  function updateNav() { setActive(atBottom() ? 'contact' : current); }
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) current = e.target.id; });
      updateNav();
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['top', 'work', 'projects', 'background', 'contact'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  window.addEventListener('scroll', updateNav, { passive: true });
})();
