// Crop/rotate editor shown in a <dialog>. Dragging draws a crop rectangle on the rotated image.
import { toCanvas, transform, type Rect } from './image';

export type Edit = { rotation: number; crop?: Rect };

export function editPhoto(dialog: HTMLDialogElement, img: ImageData, current: Edit): Promise<Edit | null> {
  let rotation = current.rotation;
  let crop = current.crop;
  dialog.innerHTML = `
    <form method="dialog" class="crop">
      <h2>Crop &amp; rotate</h2>
      <p class="muted">Drag over the text to read. Tap Reset to use the whole photo.</p>
      <div class="crop-stage"><canvas></canvas></div>
      <div class="row">
        <button type="button" data-act="left" aria-label="Rotate left">⟲</button>
        <button type="button" data-act="right" aria-label="Rotate right">⟳</button>
        <button type="button" data-act="reset">Reset</button>
        <span class="spacer"></span>
        <button value="cancel">Cancel</button>
        <button value="ok" class="primary">Done</button>
      </div>
    </form>`;
  const canvas = dialog.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  let base = toCanvas(transform(img, rotation)) as HTMLCanvasElement | OffscreenCanvas;

  const draw = () => {
    canvas.width = base.width;
    canvas.height = base.height;
    ctx.drawImage(base as CanvasImageSource, 0, 0);
    if (!crop) return;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(crop.x, crop.y + crop.h, crop.w, -crop.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = Math.max(3, canvas.width / 300);
    ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
  };
  const rotate = (by: number) => {
    rotation = (rotation + by + 360) % 360;
    crop = undefined;
    base = toCanvas(transform(img, rotation));
    draw();
  };
  draw();

  const toImage = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.min(canvas.width, Math.max(0, ((e.clientX - r.left) / r.width) * canvas.width)),
      y: Math.min(canvas.height, Math.max(0, ((e.clientY - r.top) / r.height) * canvas.height)),
    };
  };
  let start: { x: number; y: number } | undefined;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    start = toImage(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = toImage(e);
    crop = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    draw();
  });
  canvas.addEventListener('pointerup', () => {
    start = undefined;
    // A tap (tiny rectangle) clears the crop instead of selecting a sliver.
    if (crop && (crop.w < 20 || crop.h < 20)) crop = undefined;
    draw();
  });
  dialog.querySelector('[data-act=left]')!.addEventListener('click', () => rotate(-90));
  dialog.querySelector('[data-act=right]')!.addEventListener('click', () => rotate(90));
  dialog.querySelector('[data-act=reset]')!.addEventListener('click', () => {
    crop = undefined;
    draw();
  });

  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? { rotation, crop } : null), { once: true });
  });
}
