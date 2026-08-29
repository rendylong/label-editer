import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.json']

function transpileTypeScript(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      isolatedModules: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      sourceMap: false,
      inlineSourceMap: false,
    },
  })
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length > 0) {
    const message = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('; ')
    throw new Error(`TypeScript gate transpilation failed for ${fileName}: ${message}`)
  }
  return result.outputText
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw error
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
      for (const extension of SOURCE_EXTENSIONS) {
        try { return await nextResolve(`${specifier}${extension}`, context) } catch (candidateError) {
          if (candidateError?.code !== 'ERR_MODULE_NOT_FOUND') throw candidateError
        }
      }
    } else {
      try {
        const resolved = await nextResolve(`${specifier}.js`, context)
        return specifier.startsWith('ajv/dist/runtime/')
          ? { ...resolved, url: `${resolved.url}?glb-label-ajv-default=1` }
          : resolved
      } catch { /* preserve the original resolution error */ }
    }
    throw error
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('?glb-label-ajv-default=1')) {
    const target = url.slice(0, -'?glb-label-ajv-default=1'.length)
    return {
      format: 'module',
      source: `import imported from ${JSON.stringify(target)}; export default imported && imported.default ? imported.default : imported;`,
      shortCircuit: true,
    }
  }
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    return {
      format: 'module',
      source: transpileTypeScript(source, fileURLToPath(url)),
      shortCircuit: true,
    }
  }
  if (url.endsWith('.json')) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    return { format: 'module', source: `export default ${source.trim()};`, shortCircuit: true }
  }
  return nextLoad(url, context)
}
