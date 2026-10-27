# English OCR training data

`eng.traineddata.gz` is the gzip-compressed `eng.traineddata` from [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), licensed under Apache-2.0. The original is about 4.1 MB; the compressed file is about 2 MB.

The fast model provides a quicker response for selected English text. The npm `@tesseract.js-data/eng` package provides best_int and full models, but not this fast model. Keeping the data in the repository supports reproducible offline builds and avoids a build-time dependency on GitHub raw downloads.
