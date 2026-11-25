// Observe the player itself, not a section containing a tall heading and footnotes.
// Updating only on a visibility change avoids restarting timers during layout changes.
export function observeDemoPlayer(root, selector, onChange) {
  const player = root.querySelector(selector);
  let last = null;
  const update = (visible) => {
    if (visible !== last) { last = visible; onChange(visible); }
  };
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => update(entry.isIntersecting), { threshold: 0 });
    observer.observe(player);
    return;
  }
  const inspect = () => {
    const rect = player.getBoundingClientRect();
    update(rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth);
  };
  window.addEventListener('scroll', inspect, { passive: true });
  window.addEventListener('resize', inspect, { passive: true });
  inspect();
}

export function listenToMotion(motion, callback) {
  if (motion.addEventListener) motion.addEventListener('change', callback);
  else motion.addListener(callback); // Older Safari on tablets.
}

export function addMotionNote(root, toolbarSelector) {
  const note = document.createElement('p');
  note.className = 'motion-setting-note';
  note.dataset.motionNote = '';
  note.hidden = true;
  root.querySelector(toolbarSelector).after(note);
  return (reduced, running) => {
    note.hidden = !reduced;
    note.textContent = running
      ? 'Демо запущено вручную. Плавные эффекты ограничены настройкой вашей системы.'
      : 'Система отключила автоматическую анимацию. Нажмите «Воспроизвести», чтобы посмотреть демо.';
  };
}
