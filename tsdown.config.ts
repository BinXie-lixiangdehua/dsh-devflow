import { readFileSync } from 'node:fs'
import { defineConfig, type UserConfig } from 'tsdown'

const packageName = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name as string

const host: UserConfig = {
  name: `${packageName}/host`,
  entry: { index: 'lib/host/index.js' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: false,
  clean: false,
  deps: {
    neverBundle: (id: string) => id === 'zod' || id.startsWith('@deepseek-ai/'),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

const clientExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-session-controller/client',
  '@deepseek-ai/dsh-client-ui-chat/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-session/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-sidebar-right/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-session/types',
])

const client: UserConfig = {
  name: `${packageName}/client`,
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  deps: {
    neverBundle: (id: string) => clientExternals.has(id),
  },
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (clientExternals.has(source)) return null
      throw new Error(
        `client bundle purity: ${JSON.stringify(source)} is not an approved platform module; `
        + 'cross-plugin value imports must use Cordis services instead',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
