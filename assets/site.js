/* Databases & SQL study site: fit slide content to the page, contents highlighting, "More detail" toggle. */
(function () {
  var DESIGN = 1664;   // width the content was designed at
  var MIN_ZOOM = 0.55; // below this, switch to the stacked phone layout
  var NARROW_ZOOM = 0.6;
  var hasZoom = window.CSS && CSS.supports && CSS.supports('zoom', '0.5');
  var fits = Array.prototype.slice.call(document.querySelectorAll('.fit'));

  function scale(fit, canvas, z, width) {
    canvas.style.width = width + 'px';
    if (hasZoom) {
      canvas.style.zoom = z;
    } else {
      canvas.style.transform = 'scale(' + z + ')';
      fit.style.height = Math.ceil(canvas.offsetHeight * z) + 'px';
    }
  }

  function layout() {
    fits.forEach(function (fit) {
      var canvas = fit.firstElementChild;
      var w = fit.clientWidth;
      if (!w) return;
      var z = w / DESIGN, width = DESIGN, narrow = z < MIN_ZOOM;
      if (narrow) { z = NARROW_ZOOM; width = Math.floor(w / z); }
      canvas.classList.toggle('narrow', narrow);
      var hosts = canvas.querySelectorAll('.host');
      hosts.forEach(function (h) { h.style.zoom = ''; });
      scale(fit, canvas, z, width);
      if (!narrow || !hasZoom) return;
      // shrink diagrams that are wider than the column they sit in
      hosts.forEach(function (h) {
        var par = h.parentElement, cs = getComputedStyle(par);
        var avail = par.getBoundingClientRect().width - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) * z;
        var hw = h.getBoundingClientRect().width;
        if (hw > avail + 1) h.style.zoom = (avail / hw).toFixed(3);
      });
    });
  }

  var t;
  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(layout, 80); });
  layout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

  // open or close every "More detail" panel
  var details = Array.prototype.slice.call(document.querySelectorAll('details.more'));
  document.querySelectorAll('.toggle-all').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-pressed') !== 'true';
      details.forEach(function (d) { d.open = open; });
      btn.setAttribute('aria-pressed', open ? 'true' : 'false');
      btn.textContent = open ? 'Close all “More detail”' : 'Open all “More detail”';
      if (!hasZoom) layout();
    });
  });
  if (!hasZoom) details.forEach(function (d) { d.addEventListener('toggle', layout); });

  // close the phone contents list after picking a section
  document.querySelectorAll('.toc-mobile a').forEach(function (a) {
    a.addEventListener('click', function () { a.closest('details').open = false; });
  });

  // highlight the section being read in the sidebar
  var links = {};
  document.querySelectorAll('.toc a').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
  if ('IntersectionObserver' in window && Object.keys(links).length) {
    var current = null;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          if (current) current.classList.remove('active');
          current = links[e.target.id];
          if (current) {
            current.classList.add('active');
            var toc = current.closest('.toc');
            var r = current.getBoundingClientRect(), tr = toc.getBoundingClientRect();
            if (r.top < tr.top + 40 || r.bottom > tr.bottom - 40) toc.scrollTop += r.top - tr.top - tr.height / 3;
          }
        }
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('.topic').forEach(function (s) { io.observe(s); });
  }
})();
