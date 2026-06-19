import type { Plugin } from "vite";
import * as ts from "typescript";
import tsMacrosPkg from "ts-macros";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const tsMacros = (tsMacrosPkg as unknown as {
  default: (program: ts.Program) => ts.TransformerFactory<ts.SourceFile>;
}).default;

const PROJECT_ROOT = process.cwd();
const SOURCE_FILES = [
  "index.ts",
  "guardianPlugin.ts",
  "guardianCore.ts",
  "review.ts",
  "prompt.ts",
  "policyTemplate.ts",
  "policyConfig.ts",
  "commands.ts",
  "state.ts",
  "version.ts",
  "debugLog.macro.ts",
  "utils.ts",
];

function isSourceFile(path: string): boolean {
  if (SOURCE_FILES.some((s) => path.endsWith(`/${s}`) || path === s)) return true;
  return /\.(test|spec)\.ts$/.test(path);
}

export function tsMacrosPlugin(): Plugin {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: false,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    isolatedModules: false,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
  };

  const presentFiles = SOURCE_FILES.filter((f) => {
    try {
      return statSync(join(PROJECT_ROOT, f)).isFile();
    } catch {
      return false;
    }
  });

  // Also include test files for vitest runs.
  const testFiles = [
    "guardianCore.test.ts",
    "guardianPlugin.test.ts",
    "commands.test.ts",
    "state.test.ts",
    "prompt.test.ts",
    "review.test.ts",
    "review.demo.test.ts",
    "utils.test.ts",
    "macro.test.ts",
  ].filter((f) => {
    try {
      return statSync(join(PROJECT_ROOT, f)).isFile();
    } catch {
      return false;
    }
  });

  const allFiles = [...presentFiles, ...testFiles];
  const program = ts.createProgram(
    allFiles.map((f) => join(PROJECT_ROOT, f)),
    compilerOptions,
  );
  const transformerFactory = tsMacros(program);

  return {
    name: "ts-macros",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return null;
      if (id.includes("node_modules")) return null;
      if (id.includes("/dist/")) return null;
      // Only transform files that import or define the macro.
      if (!isSourceFile(id) && !code.includes("$log!")) return null;

      const fileName = id.replace(/\?.*$/, "");
      // Use the SourceFile from the program (so type checker sees it).
      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        console.log("[ts-macros] no source file in program:", fileName);
        return null;
      }

      // Update the source file's text to the latest (in case the file
      // changed on disk after the program was built).
      sourceFile.text = code;

      const result = ts.transform(sourceFile, [transformerFactory]);
      const output = ts.createPrinter().printFile(result.transformed[0]);
      result.dispose();

      const macrosMod = tsMacrosPkg as unknown as { macros: Map<unknown, unknown> };
      if (id.includes("utils.ts")) {
        console.log("[ts-macros] === utils.ts output ===");
        console.log(output);
        console.log("[ts-macros] === end ===");
      }
      if (id.includes("macro.test.ts")) {
        // Print the entire file
        console.log("[ts-macros] === full output ===");
        console.log(output);
        console.log("[ts-macros] === end ===");
      }
      return { code: output, map: null };
    },
  };
}
