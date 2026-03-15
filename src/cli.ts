#!/usr/bin/env node

import { banks, listBanks, getBank } from "./index";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--") || a.startsWith("-")));

  if (flags.has("--help") || flags.has("-h")) {
    const bankList = listBanks()
      .map((b) => `  ${b.id.padEnd(15)} ${b.name}`)
      .join("\n");

    console.log(`
open-banking-chile — Obtén tus movimientos bancarios como JSON

Uso:
  open-banking-chile --bank <banco> [opciones]

Bancos disponibles:
${bankList}

Opciones:
  --bank <id>      Banco a consultar (requerido)
  --list           Listar bancos disponibles
  --screenshots    Guardar screenshots en ./screenshots/
  --headful        Abrir Chrome visible (para debugging)
  --pretty         Formatear JSON con indentación
  --movements      Solo imprimir movimientos (sin metadata)
  --owner <T|A|B>  Filtro Titular/Adicional para TC (default: B = todos)
  --help, -h       Mostrar esta ayuda

Variables de entorno:
  <BANCO>_RUT      Tu RUT (ej: FALABELLA_RUT=12345678-9)
  <BANCO>_PASS     Tu clave de internet (ej: FALABELLA_PASS=miclave)
  CHROME_PATH      Ruta al ejecutable de Chrome/Chromium (opcional)

Ejemplos:
  # Banco Falabella
  FALABELLA_RUT=12345678-9 FALABELLA_PASS=miclave open-banking-chile --bank falabella --pretty

  # Listar bancos disponibles
  open-banking-chile --list

  # Solo movimientos, pipe a jq
  open-banking-chile --bank falabella --movements | jq '.[].description'
`);
    process.exit(0);
  }

  if (flags.has("--list")) {
    console.log("\nBancos disponibles:\n");
    for (const b of listBanks()) {
      console.log(`  ${b.id.padEnd(15)} ${b.name.padEnd(25)} ${b.url}`);
    }
    console.log(`\nTotal: ${listBanks().length} banco(s)`);
    console.log("¿Tu banco no está? ¡Contribuye! Ver CONTRIBUTING.md\n");
    process.exit(0);
  }

  // Parse --bank flag
  const bankIdx = args.indexOf("--bank");
  const bankId = bankIdx >= 0 ? args[bankIdx + 1] : undefined;

  if (!bankId) {
    const available = Object.keys(banks).join(", ");
    console.error(
      `Error: Debes especificar un banco con --bank <id>\n` +
      `Bancos disponibles: ${available}\n` +
      `Usa --list para más detalles o --help para ayuda.`
    );
    process.exit(1);
  }

  const bank = getBank(bankId);
  if (!bank) {
    const available = Object.keys(banks).join(", ");
    console.error(
      `Error: Banco "${bankId}" no encontrado.\n` +
      `Bancos disponibles: ${available}\n` +
      `Usa --list para más detalles.`
    );
    process.exit(1);
  }

  // Get credentials from env
  const prefix = bankId.toUpperCase();
  const rut = process.env[`${prefix}_RUT`];
  const password = process.env[`${prefix}_PASS`];

  if (!rut || !password) {
    console.error(
      `Error: Se requieren las variables ${prefix}_RUT y ${prefix}_PASS\n` +
      `Ejemplo: ${prefix}_RUT=12345678-9 ${prefix}_PASS=miclave open-banking-chile --bank ${bankId}\n` +
      `O copia .env.example a .env y rellena tus datos.`
    );
    process.exit(1);
  }

  if (flags.has("--screenshots")) {
    console.warn(
      "⚠️  --screenshots guarda imágenes y HTML con datos bancarios en ./screenshots/ y ./debug/\n" +
      "   No compartas estos archivos ni los subas a git."
    );
  }

  // Parse --owner flag
  const ownerIdx = args.indexOf("--owner");
  const ownerVal = ownerIdx >= 0 ? args[ownerIdx + 1]?.toUpperCase() : undefined;
  const owner = ownerVal === "T" || ownerVal === "A" || ownerVal === "B" ? ownerVal : undefined;

  const result = await bank.scrape({
    rut,
    password,
    chromePath: process.env.CHROME_PATH,
    saveScreenshots: flags.has("--screenshots"),
    headful: flags.has("--headful"),
    ...(owner && { owner }),
  });

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    if (result.debug) {
      console.error("\nDebug log:");
      console.error(result.debug);
    }
    process.exit(1);
  }

  const indent = flags.has("--pretty") ? 2 : undefined;

  if (flags.has("--movements")) {
    console.log(JSON.stringify(result.movements, null, indent));
  } else {
    const { screenshot: _, ...output } = result;
    console.log(JSON.stringify(output, null, indent));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
