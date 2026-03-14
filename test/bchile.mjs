import pkg from "../dist/index.js";
const { bchile } = pkg;
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter(l => l && !l.startsWith("#"))
    .map(l => l.split("=").map(s => s.trim()))
);

const result = await bchile.scrape({
  rut: env.BCHILE_RUT,
  password: env.BCHILE_PASS,
  headful: true,
});

if (result.success) {
  const { screenshot, ...output } = result;
  console.log(JSON.stringify(output, null, 2));
} else {
  console.error("Error:", result.error);
  console.error("Debug:", result.debug);
}
