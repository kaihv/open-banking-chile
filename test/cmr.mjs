import pkg from "../dist/index.js";
const { cmr } = pkg;
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const ownerArg = process.argv.find(a => a.startsWith("--owner="));
const owner = ownerArg ? ownerArg.split("=")[1].toUpperCase() : undefined;

const result = await cmr.scrape({
  rut: env.CMR_RUT,
  password: env.CMR_PASS,
  headful: process.argv.includes("--headful"),
  saveScreenshots: process.argv.includes("--screenshots"),
  ...(owner && { owner }),
});

if (result.success) {
  const { screenshot, ...output } = result;
  console.log(JSON.stringify(output, null, 2));
} else {
  console.error("Error:", result.error);
  console.error("Debug:", result.debug);
}
