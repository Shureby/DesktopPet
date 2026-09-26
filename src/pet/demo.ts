/** Browser mock only: lets you drag the fake windows around to test riding and falling. */
export function enableFakeWindowDragging(): void {
  for (const win of document.querySelectorAll<HTMLElement>(".fake-window")) {
    const header = win.querySelector("header");
    header?.addEventListener("pointerdown", (e) => {
      const ox = e.clientX - win.offsetLeft;
      const oy = e.clientY - win.offsetTop;
      header.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        win.style.left = `${ev.clientX - ox}px`;
        win.style.top = `${ev.clientY - oy}px`;
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", () => header.removeEventListener("pointermove", move), { once: true });
    });
  }
}
