// Runs the riff analysis off the main thread so the page stays responsive.
import { analyzeRiff } from './analysis.js';
self.onmessage = (e) => {
  const { x, sr } = e.data;
  try { self.postMessage({ ok: true, result: analyzeRiff(x, sr) }); }
  catch (err) { self.postMessage({ ok: false, error: String(err && err.message || err) }); }
};
