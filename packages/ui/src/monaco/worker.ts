// The Monaco editor worker, bundled as its own IIFE target
// (dist/<browser>/monaco/editor.worker.js) and created by packages/ui/src/monaco/editor.ts
// via `new Worker(runtime.getURL(...))` — a same-origin extension resource,
// which the default MV3 CSP (script-src 'self') allows without blob:.
import "monaco-editor/editor/editor.worker";
