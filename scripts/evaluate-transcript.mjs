import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (!args.reference || !args.hypothesis) {
  console.error("Usage: npm run eval:transcript -- --reference reference.txt --hypothesis export.json");
  process.exit(1);
}

const referenceText = normalizeText(readTranscript(args.reference));
const hypothesisText = normalizeText(readTranscript(args.hypothesis));

const referenceChars = Array.from(referenceText.replace(/\s+/g, ""));
const hypothesisChars = Array.from(hypothesisText.replace(/\s+/g, ""));
const referenceTokens = tokenize(referenceText);
const hypothesisTokens = tokenize(hypothesisText);

const charDistance = levenshtein(referenceChars, hypothesisChars);
const tokenDistance = levenshtein(referenceTokens, hypothesisTokens);

const report = {
  reference: path.resolve(args.reference),
  hypothesis: path.resolve(args.hypothesis),
  referenceChars: referenceChars.length,
  hypothesisChars: hypothesisChars.length,
  charDistance,
  charErrorRate: rate(charDistance, referenceChars.length),
  charAccuracy: rate(Math.max(0, referenceChars.length - charDistance), referenceChars.length),
  referenceTokens: referenceTokens.length,
  hypothesisTokens: hypothesisTokens.length,
  tokenDistance,
  tokenErrorRate: rate(tokenDistance, referenceTokens.length),
  tokenAccuracy: rate(Math.max(0, referenceTokens.length - tokenDistance), referenceTokens.length)
};

console.log(JSON.stringify(report, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (current === "--reference") parsed.reference = values[index + 1];
    if (current === "--hypothesis") parsed.hypothesis = values[index + 1];
  }
  return parsed;
}

function readTranscript(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const trimmed = raw.trim();

  if (!trimmed.startsWith("{")) return trimmed;

  const parsed = JSON.parse(trimmed);
  if (typeof parsed.transcriptText === "string") return parsed.transcriptText;
  if (Array.isArray(parsed.segments)) {
    return parsed.segments.map((segment) => segment.text || "").join("\n");
  }

  return trimmed;
}

function normalizeText(value) {
  return value
    .normalize("NFKC")
    .replace(/[，。！？；：“”‘’、,.!?;:"'()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  if (Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    return Array.from(segmenter.segment(value))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  }

  return value.split(/\s+/).filter(Boolean);
}

function levenshtein(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost
      );
    }
    previous = current;
  }

  return previous[right.length];
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}
