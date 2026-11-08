// In-app camera with a live glare overlay: blown-out highlights are striped red so the card
// can be tilted away from the light before the photo is taken.
import { detectGlare, hasGlare, paintGlare } from './image';

const PREVIEW_WIDTH = 240;

type ImageCaptureLike = { takePhoto(): Promise<Blob> };
declare const ImageCapture: { new (track: MediaStreamTrack): ImageCaptureLike } | undefined;

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

/** Shows the viewfinder; resolves with the photo, or null if the user closed it. */
export async function takePhoto(root: HTMLElement): Promise<Blob | null> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];

  const view = document.createElement('div');
  view.className = 'camera';
  view.innerHTML = `
    <div class="camera-frame">
      <video playsinline muted></video>
      <canvas class="camera-glare"></canvas>
    </div>
    <p class="camera-hint" role="status"></p>
    <div class="camera-controls">
      <button type="button" class="camera-close" aria-label="Close camera">✕</button>
      <button type="button" class="camera-shutter" aria-label="Take photo"></button>
      <span></span>
    </div>`;
  root.append(view);
  const video = view.querySelector('video')!;
  const overlay = view.querySelector<HTMLCanvasElement>('.camera-glare')!;
  const hint = view.querySelector<HTMLElement>('.camera-hint')!;
  video.srcObject = stream;
  await video.play();

  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
  const overlayCtx = overlay.getContext('2d')!;
  let frame = 0;
  let timer = 0;
  const analyse = () => {
    if (video.videoWidth) {
      probe.width = overlay.width = PREVIEW_WIDTH;
      probe.height = overlay.height = Math.round((PREVIEW_WIDTH * video.videoHeight) / video.videoWidth);
      probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
      const px = probeCtx.getImageData(0, 0, probe.width, probe.height);
      const out = overlayCtx.createImageData(px.width, px.height);
      paintGlare(px, out, frame++ * 2);
      overlayCtx.putImageData(out, 0, 0);
      const glare = hasGlare(detectGlare(px, 8));
      hint.textContent = glare ? 'Glare on the card — tilt it or move away from the light' : 'Fill the frame with the card text';
      hint.classList.toggle('warn', glare);
    }
    timer = window.setTimeout(analyse, 150);
  };
  analyse();

  const close = () => {
    clearTimeout(timer);
    track.stop();
    view.remove();
  };

  return new Promise((resolve) => {
    view.querySelector('.camera-close')!.addEventListener('click', () => {
      close();
      resolve(null);
    });
    view.querySelector('.camera-shutter')!.addEventListener('click', async () => {
      let blob: Blob | null = null;
      try {
        // A still photo is sharper and higher resolution than a video frame where supported.
        if (typeof ImageCapture !== 'undefined') blob = await new ImageCapture(track).takePhoto();
      } catch {
        blob = null;
      }
      if (!blob) {
        const c = document.createElement('canvas');
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext('2d')!.drawImage(video, 0, 0);
        blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
      }
      close();
      resolve(blob);
    });
  });
}
