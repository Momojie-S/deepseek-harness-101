/**
 * Atomic build: compile to a staging directory, gate on a clean import of
 * the staged entry (apply must be a function, all imports must resolve),
 * then swap lib/ in one rename pair.
 *
 * Why: plain `tsc` emits files one by one directly into lib/. If dsh
 * restarts mid-build, the loader can import a truncated lib/index.js — an
 * empty ESM namespace has no `apply`, which aborts the entire harness boot.
 * Staging + rename shrinks that window to "between two renames"; a failed
 * build keeps the previous good lib/.
 *
 * Shared template — same shape as plugins/dsh-bili-operator and
 * plugins/dsh-schedspawn (host + client bundle via __ModuleLoader__).
 */
import { execSync } from 'node:child_process'
import { readFile, rm, rename, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const stage = join(root, 'lib-tmp')
const live = join(root, 'lib')
const retired = join(root, 'lib-old')
const pkgName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name

// ---- 1. compile into staging ----
// tsc comes from the junctioned toolchain (node_modules/typescript — see
// README 安装); invoking it via node keeps npm-run and direct calls identical.
await rm(stage, { recursive: true, force: true })
execSync(`node ${JSON.stringify(join(root, 'node_modules', 'typescript', 'bin', 'tsc'))} --outDir lib-tmp`, { cwd: root, stdio: 'inherit' })

// ---- 2. import gate: the staged entry must load and export apply ----
const staged = await import(`${pathToFileURL(join(stage, 'index.js')).href}?gate=${Date.now()}`)
if (typeof staged.apply !== 'function') {
  throw new Error('build gate: staged lib/index.js has no apply export — refusing to swap')
}

// ---- 3. client bundle into staging (concatenation, no bundler) ----
const clientSrc = join(root, 'src', 'client', 'index.js')
const body = await readFile(clientSrc, 'utf8')
if (/^\s*import\s/m.test(body)) {
  throw new Error('client bundle: src/client/index.js must not use import (externals go through require)')
}
const bundle = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkgName)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  body.trimEnd(),
  'return module.exports; } });',
  '',
].join('\n')
await writeFile(join(stage, 'client.js'), bundle, 'utf8')

// ---- 4. client-bundle gate: consume it exactly like the browser loader ----
{
  const react = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: () => ({ current: 0 }),
    Component: class {},
  }
  const loadCalls = []
  const fakeWindow = { __ModuleLoader__: { load: (desc) => { loadCalls.push(desc) } } }
  const fn = new Function('window', 'return (function () { ' + bundle + '\n})')
  fn(fakeWindow).call(fakeWindow)
  const desc = loadCalls[0]
  if (desc === undefined) throw new Error('no __ModuleLoader__.load call')
  const factoryRequire = (spec) => {
    if (spec === 'react') return react
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      // platform baseline external (shell seed module table): stub the
      // components the bundle touches so the gate can execute it offline
      const stub = () => null
      return { Menu: stub, Button: stub, Switch: stub }
    }
    throw new Error(`client gate: unexpected require "${spec}" (module-table externals only)`)
  }
  const factoryModule = { exports: {} }
  const returned = desc.factory.call(factoryModule.exports, factoryRequire)
  const pluginExports = returned ?? factoryModule.exports
  if (typeof pluginExports.apply !== 'function') {
    throw new Error('client gate: bundle exports have no apply — the browser entry would fail with "invalid plugin"')
  }
  if (!Array.isArray(pluginExports.inject)) {
    throw new Error('client gate: bundle exports declare no inject list')
  }
}

// ---- 5. atomic-ish swap ----
const liveExists = await readdir(live).then(() => true, () => false)
if (liveExists) {
  await rm(retired, { recursive: true, force: true })
  await rename(live, retired)
}
try {
  await rename(stage, live)
} catch (error) {
  if (liveExists) await rename(retired, live)
  throw error
}
await rm(retired, { recursive: true, force: true })

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
console.log(`build: lib/ swapped atomically (host + client, ${pkg.name})`)
