import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import importPlugin from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Compiled output, not source: esbuild artifacts from `npm run build:stdlib`.
    ignores: ['dist', '.stdlib-build', 'public/stdlib-js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      import: importPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Keep the project's previous react-hooks recommended rule set.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Empty interfaces are used as intentional extension points in the
      // custom-widget SDK and datasource settings contracts.
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'always' },
      ],
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/hmi/**',
              from: './src/config/**',
              message: '❌ hmi/ cannot import from config/ — violates dependency rule. Import from @shared/ instead.',
            },
            {
              target: './src/hmi/**',
              from: './src/config',
              message: '❌ hmi/ cannot import from config/ — violates dependency rule. Import from @shared/ instead.',
            },
            {
              target: './src/shared/**',
              from: './src/hmi/**',
              message: '❌ shared/ cannot import from hmi/ — violates dependency rule.',
            },
            {
              target: './src/shared/**',
              from: './src/config/**',
              message: '❌ shared/ cannot import from config/ — violates dependency rule.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/hmi/page-templates/**/index.tsx',
      'src/hmi/registry/pageTemplateRegistry.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Product stdlib widgets are authored against the custom-widget contract:
    // every helper is an ambient global from window.__nextHMI__ (declared in
    // custom-widgets-sdk.d.ts and type-checked by tsconfig.stdlib.json), and the
    // `schema` / `description` / `icon` / `category` exports beside the default
    // export are required metadata, not accidental non-component exports.
    files: ['widgets/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'import/no-restricted-paths': 'off',
    },
  },
  eslintConfigPrettier,
)
