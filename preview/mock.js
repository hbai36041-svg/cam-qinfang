// ---- Preview-only stand-ins: no server, no real WebRTC. Demo video & captions. ----
const __nav = { path: '/', go(p) { this.path = p; } };

function drawPerson(g, w, h, t, o) {
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, o.bg1); bg.addColorStop(1, o.bg2);
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // window light
  g.fillStyle = 'rgba(191,227,255,0.06)'; g.fillRect(w * 0.62, h * 0.08, w * 0.3, h * 0.5);
  const cx = w * o.x, sway = Math.sin(t * 1.3) * 6;
  // body
  g.fillStyle = o.cloth; g.beginPath(); g.ellipse(cx + sway * 0.3, h * 0.98, w * 0.2, h * 0.32, 0, 0, Math.PI * 2); g.fill();
  // neck + face (skin tones, with fixed speckle so smoothing is visible)
  g.fillStyle = o.skin; g.fillRect(cx - w * 0.03 + sway * 0.4, h * 0.5, w * 0.06, h * 0.14);
  g.beginPath(); g.ellipse(cx + sway * 0.5, h * 0.4, w * 0.075, h * 0.17, 0, 0, Math.PI * 2); g.fill();
  if (!o.speckle) {
    o.speckle = [];
    let s = o.seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 260; i++) o.speckle.push([r() * 2 - 1, r() * 2 - 1, r() * 2.4 + 0.6, r() < 0.5]);
  }
  for (const [dx, dy, rad, dark] of o.speckle) {
    if (dx * dx + dy * dy > 0.8) continue;
    g.fillStyle = dark ? 'rgba(120,60,40,0.35)' : 'rgba(255,230,210,0.35)';
    g.beginPath(); g.arc(cx + sway * 0.5 + dx * w * 0.065, h * 0.4 + dy * h * 0.15, rad, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = o.hair; g.beginPath(); g.ellipse(cx + sway * 0.5, h * 0.27, w * 0.08, h * 0.08, 0, Math.PI, Math.PI * 2); g.fill();
  // violin under the chin
  g.save(); g.translate(cx - w * 0.07 + sway * 0.5, h * 0.62); g.rotate(-0.55);
  g.fillStyle = '#7a3b16'; g.beginPath(); g.ellipse(0, 0, w * 0.085, h * 0.075, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#5b2a0e'; g.fillRect(w * 0.06, -h * 0.012, w * 0.17, h * 0.024);
  g.strokeStyle = 'rgba(255,240,220,0.7)'; g.lineWidth = 1.2;
  for (let i = -1; i <= 2; i++) { g.beginPath(); g.moveTo(-w * 0.05, i * 3); g.lineTo(w * 0.22, i * 2); g.stroke(); }
  g.restore();
  // bow, moving back and forth
  const bx = Math.sin(t * 2.2) * w * 0.09;
  g.strokeStyle = '#d9c7a6'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(cx - w * 0.2 + bx, h * 0.5); g.lineTo(cx + w * 0.16 + bx, h * 0.86); g.stroke();
  g.fillStyle = 'rgba(245,249,255,0.55)'; g.font = `600 ${Math.round(h * 0.032)}px system-ui, sans-serif`;
  g.fillText(o.label, w * 0.03, h * 0.07);
}
const demoScenes = {
  self: { x: 0.42, bg1: '#1d3557', bg2: '#0b1c36', skin: '#e2b49a', cloth: '#22303f', hair: '#2a1d16', seed: 11, label: '演示画面 · DEMO' },
  remote: { x: 0.55, bg1: '#2b2f45', bg2: '#11182b', skin: '#f0c7ae', cloth: '#3b2f4a', hair: '#7a5232', seed: 29, label: 'Иван · DEMO' },
};
function demoStream(which) {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d'); const o = demoScenes[which]; const t0 = performance.now();
  const draw = () => drawPerson(g, c.width, c.height, (performance.now() - t0) / 1000, o);
  draw(); setInterval(draw, 40);
  return c.captureStream(25);
}
