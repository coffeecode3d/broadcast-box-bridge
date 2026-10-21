import { buildSync } from "esbuild";
import { mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist/doctor.mjs");

mkdirSync(join(root, "dist"), { recursive: true });
buildSync({
    entryPoints: [join(root, "scripts/doctor.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    logLevel: "warning"
});

await import(pathToFileURL(outfile).href);
