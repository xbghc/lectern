# OCR training data

`eng.traineddata.gz` is the gzip-compressed `eng.traineddata` from [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), licensed under Apache-2.0. The original is about 4.1 MB; the compressed file is about 2 MB.

The fast model provides a quicker response for selected English text. The npm `@tesseract.js-data/eng` package provides best_int and full models, but not this fast model. Keeping the data in the repository supports reproducible offline builds and avoids a build-time dependency on GitHub raw downloads.

`chi_sim.traineddata.gz` and `chi_tra.traineddata.gz` add simplified and traditional Chinese using the same Apache-2.0-licensed [tessdata_fast revision `8741641`](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd). They are gzip-compressed with `mtime=0` and together add about 3.4 MB. SHA-256 of the uncompressed originals:

- `chi_sim`: `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730`
- `chi_tra`: `529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b`

The extension loads all three models locally. `npm run ocr-check` checks the real OCR engine against English and Chinese fixtures.
