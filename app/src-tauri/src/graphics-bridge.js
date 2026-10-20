// Runs inside a motion graphic while the editor shows it. The editor sends
// the time to show ({roughcut: "seek", t}); the graphic says when it's ready.
(() => {
  const send = (m) => parent.postMessage(Object.assign({ roughcut: "graphic" }, m), "*");
  let want = null;
  let ready = false;
  const seek = (t) => {
    try {
      window.__player.seek(Math.max(0, t));
    } catch (e) {}
  };
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.roughcut !== "seek") return;
    want = m.t;
    if (ready) seek(want);
  });
  const wait = () => {
    if (!(window.__player && window.__renderReady)) return void setTimeout(wait, 50);
    ready = true;
    try {
      window.__player.pause();
    } catch (e) {}
    const root = document.querySelector("[data-composition-id]");
    const size = (k, d) => Number(root && root.getAttribute(k)) || d;
    send({ ready: true, duration: window.__player.getDuration ? window.__player.getDuration() : 0, width: size("data-width", 1920), height: size("data-height", 1080) });
    seek(want ?? 0);
  };
  window.addEventListener("error", (e) => send({ error: String(e.message || e) }));
  wait();
})();
