# OCR fixtures

`ocr-probe.png` checks English recognition. The Chinese fixtures contain two public-domain sentences from the Analects, rendered horizontally at 48 px using Noto Sans CJK SC on a white 720 × 200 canvas, with 32 px left padding and 78 px between lines. They cover simplified and traditional character recognition without relying on network downloads at test time.

Run `npm run ocr-check` to exercise the same three bundled language models and line cleaning used by the extension. Assertions check recognizable clauses from both lines, allowing simplified/traditional normalization; they do not assert a perfect transcript. The fast models can misread individual characters in these samples (including `乎` as `平`). These clean printed samples do not cover handwriting, vertical columns or degraded scans.
