// ESLint flat config. Adapted from the sibling twikki project's config, with
// three deliberate departures, since this repo is TypeScript + Prettier where
// twikki is plain JS + strongloop:
//
//   1. typescript-eslint replaces strongloop — without a TS parser, nothing
//      under packages/ would parse at all.
//   2. No style rules (quotes, semi, object-curly-spacing, max-len). Prettier
//      owns formatting here; twikki's `object-curly-spacing: never` is the
//      exact opposite of what Prettier writes (`{ resolve }`), so keeping it
//      would flag essentially every import in the repo.
//   3. Globals are per-package: the renderer is browser code, the server and
//      Electron main are Node.
//
// Kept from twikki: `require-await`, a generous `complexity` ceiling, and
// `no-eval` off (the `script` cell renderer evaluates user-authored bodies by
// design — see docs/tech/PLUGINS.md).

import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: [
      // Build output, all of it gitignored — `packages/electron/build/` in
      // particular holds a bundled, minified renderer that on its own
      // accounted for 1449 of the first run's 1579 reports.
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      'packages/electron/frontend/**',
      // Self-contained demo plugins served verbatim to the browser; they are
      // not part of the compiled workspace.
      'packages/renderer/public/plugins/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // twikki has this as an error; here it's a warning, because a large part
      // of this codebase is `async` *by contract* rather than by need — the
      // whole plugin API surface is Promise-based (see plugin-api.ts), so
      // `DataCollection.find`, `api.ui.dialogs.alert`, `backend.saveFile` and
      // friends must stay async even on paths that resolve synchronously. The
      // rule only inspects a function body, never the interface it satisfies,
      // so as an error it would demand a pointless `await` in ~30 correct
      // implementations.
      'require-await': 'warn',
      complexity: ['warn', 40],
      'no-eval': 'off',
      // The codebase already annotates every deliberate console call with
      // `// eslint-disable-next-line no-console`, so this rule was clearly
      // meant to be on — without it those directives are dead and ESLint
      // reports each one as unused.
      'no-console': 'error',
    },
  },
  {
    // Renderer: browser environment (Lit components, DOM, IndexedDB).
    files: ['packages/renderer/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Server + Electron main: Node environment.
    files: ['packages/server/**/*.ts', 'packages/electron/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Plain CommonJS scripts (the Electron dev runner) — `require`,
    // `__dirname` and friends, which `sourceType: 'module'` would reject.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
