(function () {
  var nav = document.getElementById('nav');
  var menu = document.getElementById('menu');

  if (menu && nav) {
    var setOpen = function (open) {
      nav.classList.toggle('open', open);
      menu.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.setAttribute('aria-label', open ? '收起导航' : '展开导航');
    };
    menu.addEventListener('click', function () {
      setOpen(menu.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && nav.classList.contains('open')) {
        setOpen(false);
        menu.focus();
      }
    });
  }

  var targets = document.querySelectorAll('.band .card, .band .panel, .band .shot, .band .steps li, .close-in');
  Array.prototype.forEach.call(targets, function (node) {
    node.setAttribute('data-reveal', '');
  });

  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(targets, function (node) { node.classList.add('in'); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

  Array.prototype.forEach.call(targets, function (node) { observer.observe(node); });
}());
