// Barcode-Scanner: Kamera + native BarcodeDetector (falls vorhanden) oder ZXing (offline gebündelt).

export function normalizeCode(code) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length > 8) code = code.replace(/^0+/, '').padStart(13, '0');
  return code;
}

function makeZxingDecoder() {
  const Z = window.ZXing;
  if (!Z) return null;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
  ]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  return canvas => {
    try {
      const src = new Z.HTMLCanvasElementLuminanceSource(canvas);
      const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
      return reader.decode(bmp).getText();
    } catch (e) {
      return null; // kein Code im Bild
    } finally {
      reader.reset();
    }
  };
}

async function makeNativeDecoder() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(f => supported.includes(f));
    if (!formats.length) return null;
    const det = new window.BarcodeDetector({ formats });
    return async canvas => {
      const r = await det.detect(canvas);
      return r.length ? r[0].rawValue : null;
    };
  } catch { return null; }
}

/**
 * Startet den Scanner in einem Container-Element.
 * Gibt { stop() } zurück; onCode(ean) wird bei bestätigtem Treffer genau einmal aufgerufen.
 */
export async function startScanner(video, onCode, onStatus) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Kamera nicht verfügbar. Die App muss über https geöffnet werden.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});

  const native = await makeNativeDecoder();
  const zxing = makeZxingDecoder();
  if (!native && !zxing) throw new Error('Barcode-Bibliothek konnte nicht geladen werden.');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let running = true, last = null, hits = 0, frame = 0;

  const tick = async () => {
    if (!running) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      // Mittleren Bereich ausschneiden (dort ist der Rahmen), das macht ZXing schneller
      const cw = Math.round(vw * 0.8), ch = Math.round(Math.min(vh * 0.5, cw * 0.6));
      const sx = Math.round((vw - cw) / 2), sy = Math.round((vh - ch) / 2 - vh * 0.05);
      const scale = Math.min(1, 1000 / cw);
      canvas.width = Math.round(cw * scale);
      canvas.height = Math.round(ch * scale);
      ctx.drawImage(video, sx, Math.max(0, sy), cw, ch, 0, 0, canvas.width, canvas.height);
      let code = null;
      try {
        code = native ? await native(canvas) : null;
        if (!code && zxing) code = zxing(canvas);
      } catch { /* weiter */ }
      if (code) {
        code = normalizeCode(code);
        // ZXing liest selten falsch – zur Sicherheit zweimal denselben Code verlangen
        hits = code === last ? hits + 1 : 1;
        last = code;
        if (hits >= 2 || native) {
          running = false;
          if (navigator.vibrate) navigator.vibrate(60);
          stop();
          onCode(code);
          return;
        }
      }
      if (++frame === 30 && onStatus) onStatus('Barcode in den Rahmen halten …');
    }
    setTimeout(() => requestAnimationFrame(tick), 60);
  };
  requestAnimationFrame(tick);

  function stop() {
    running = false;
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
  return { stop };
}
