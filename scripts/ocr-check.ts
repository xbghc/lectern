import { fileURLToPath } from "node:url";
import { createWorker, OEM, PSM } from "tesseract.js";
import { cleanOcrLines } from "../src/lib/ocrText.ts";

/*
 * 改过预处理或清洗规则就跑一次：单元测试只能验证规则，真实截图才看得出识别是否退步。
 * 需要读取训练数据并跑 wasm，单独执行，不进 npm test。
 * Node 版支持本地目录的 langPath，内部用 fs 读取 .traineddata.gz；转成绝对文件路径，
 * 避免 Windows 盘符被当成 URL，也不依赖启动时的工作目录。不写语言缓存。
 */
const start = performance.now();
const worker = await createWorker(["eng", "chi_sim", "chi_tra"], OEM.LSTM_ONLY, {
  langPath: fileURLToPath(new URL("../vendor/tesseract/", import.meta.url)),
  gzip: true,
  cacheMethod: "none",
});
try {
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  const initialized = performance.now();
  console.log(`Initialization time: ${(initialized - start).toFixed(0)} ms`);
  for (const [fixture, expected] of [
    ["ocr-probe.png", [/tacit endorsement/, /plainly untenable/]],
    // 多语种识别可能把繁体归一成简体；这里验证两种输入都能识别出中文内容，
    // 不把字形归一误报为完全不支持繁体，也不声称 OCR 能逐字无误地转录古籍。
    ["ocr-chinese-simplified.png", [/[学學]而[时時][习習]之/, /有朋自[远遠]方[来來]/]],
    ["ocr-chinese-traditional.png", [/[学學]而[时時][习習]之/, /有朋自[远遠]方[来來]/]],
  ] as const) {
    const recognizing = performance.now();
    // v7 的行数据在 blocks 内，默认关闭；与扩展使用同一份行文本与置信度。
    const { data } = await worker.recognize(fileURLToPath(new URL(`fixtures/${fixture}`, import.meta.url)), {}, { blocks: true });
    const text = cleanOcrLines((data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.map((line) => ({ text: line.text, confidence: line.confidence })))));
    console.log(`${fixture}: ${text}`);
    console.log(`Recognition time: ${(performance.now() - recognizing).toFixed(0)} ms`);
    for (const pattern of expected) if (!pattern.test(text)) {
      console.error(`Expected recognized text to match: ${pattern}`);
      process.exitCode = 1;
    }
  }
} finally {
  await worker.terminate();
}
