import pkg from "../dist/index.js";
const { itau } = pkg;
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const result = await itau.scrape({
  rut: env.ITAU_RUT,
  password: env.ITAU_PASS,
  headful: process.argv.includes("--headful"),
  saveScreenshots: process.argv.includes("--screenshots"),
});

if (result.success) {
  const { screenshot, ...output } = result;
  console.log(JSON.stringify(output, null, 2));
} else {
  console.error("Error:", result.error);
  console.error("Debug:", result.debug);
}
