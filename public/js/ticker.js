// Worker timer: keeps the beauty pipeline producing frames while the tab is in the background
// (main-thread timers and requestAnimationFrame are throttled or paused there).
let id = null;
self.onmessage = (e) => {
  clearInterval(id);
  const fps = e.data?.fps || 30;
  if (fps > 0) id = setInterval(() => self.postMessage(0), Math.round(1000 / fps));
};
