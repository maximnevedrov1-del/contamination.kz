// SaudaPulse landing page: small enhancements only. Without this file every section is
// still readable (the <html class="js"> switch turns the effects on).
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const io = (cb, opts) => new IntersectionObserver((entries) => entries.forEach(cb), opts);

  // header line once the page is scrolled; sticky phone call-to-action after the first screen
  const top = document.getElementById('top');
  const mcta = document.querySelector('.mcta');
  const hero = document.querySelector('.hero');
  const onScroll = () => {
    top.classList.toggle('is-scrolled', scrollY > 8);
    mcta?.classList.toggle('is-on', hero.getBoundingClientRect().bottom < 0);
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // things appear once when scrolled into view
  const reveal = io((e) => e.isIntersecting && (e.target.classList.add('is-in'), revealObs.unobserve(e.target)), { rootMargin: '0px 0px -8% 0px' });
  const revealObs = reveal;
  document.querySelectorAll('.reveal').forEach((el) => reveal.observe(el));

  // five cabinets fly into one table
  const stage = document.querySelector('[data-merge]');
  if (stage) {
    io((e) => e.isIntersecting && e.intersectionRatio > 0.45 && stage.classList.add('is-in'), { threshold: [0, 0.45, 0.8] }).observe(stage);
  }

  // scroll story: the step in the middle of the screen chooses the picture
  const steps = [...document.querySelectorAll('.story__step')];
  const pics = document.querySelectorAll('.story__pics img');
  const extra = document.querySelector('.story__extra');
  const show = (name) => {
    steps.forEach((s) => s.classList.toggle('is-active', s.dataset.step === name));
    pics.forEach((p) => p.classList.toggle('is-on', p.dataset.pic === name));
    extra?.classList.toggle('is-on', extra.dataset.extra === name);
  };
  if (steps.length) {
    show(steps[0].dataset.step);
    const storyObs = io((e) => e.isIntersecting && show(e.target.dataset.step), { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach((s) => storyObs.observe(s));
  }

  // the hero screenshot leans towards the mouse (mouse devices only, never on touch)
  const tilt = document.querySelector('[data-tilt]');
  if (tilt && !reduce && matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1001px)').matches) {
    let raf = 0;
    addEventListener('pointermove', (ev) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = tilt.getBoundingClientRect();
        const x = (ev.clientX - (r.left + r.width / 2)) / innerWidth; // −0.5 … 0.5
        const y = (ev.clientY - (r.top + r.height / 2)) / innerHeight;
        tilt.style.transform = `rotateY(${(-8 + x * 10).toFixed(2)}deg) rotateX(${(4 - y * 8).toFixed(2)}deg)`;
      });
    });
  }

  // «Open» buttons: if the extension is installed, ask it to open the dashboard; otherwise (not
  // installed / no id yet / no answer in 800 ms) follow the link as usual (store or in-page anchor).
  const extId = document.querySelector('meta[name="sp-extension-id"]')?.content?.trim();
  document.querySelectorAll('[data-sp-open]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      if (!extId || !window.chrome?.runtime?.sendMessage) return; // plain link
      ev.preventDefault();
      let done = false;
      const fallback = () => { if (done) return; done = true; if (a.hash && a.pathname === location.pathname) location.hash = a.hash; else location.href = a.href; };
      const timer = setTimeout(fallback, 800);
      try {
        chrome.runtime.sendMessage(extId, { type: 'OPEN_DASHBOARD' }, (res) => {
          void chrome.runtime.lastError; // "Could not establish connection" = not installed
          clearTimeout(timer);
          if (done) return;
          if (res?.ok) done = true; else fallback();
        });
      } catch { clearTimeout(timer); fallback(); }
    });
  });
})();
