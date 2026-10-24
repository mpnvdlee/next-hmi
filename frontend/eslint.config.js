import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import importPlugin from 'eslint-plugin-import-x'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Compiled output, not source: esbuild artifacts from `npm run build:builtin-widgets`.
    ignores: ['dist', '.builtin-widgets-build', 'public/builtin-widgets-js'],
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
    // The product's built-in widgets are authored against the custom-widget
    // contract: every helper is an ambient global from window.__nextHMI__
    // (declared in custom-widgets-sdk.d.ts and type-checked by
    // tsconfig.builtin-widgets.json), and the
    // `schema` / `description` / `icon` / `category` exports beside the default
    // export are required metadata, not accidental non-component exports.
    files: ['widgets/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Hard rule: no inline styles. Only a CSS custom property may be set via
    // `style={{ '--name': value }}`; everything else is a class and a token.
    files: ['**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression > Property[key.type='Identifier']",
          message:
            'No inline styles: use a class and a token. Only a CSS custom property may be set inline.',
        },
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression > Property > Literal.key[value=/^(?!--)/]",
          message:
            'No inline styles: use a class and a token. Only a CSS custom property may be set inline.',
        },
      ],
    },
  },
  {
    // Inline styles that predate the rule. Remove a file once it is fixed;
    // never add one.
    files: [
      'src/config/components/compositions/CompositionTabBar.tsx',
      'src/config/components/editor/ChildPositionsEditor/index.tsx',
      'src/config/components/editor/ColorInput/index.tsx',
      'src/config/components/editor/ImageIndicatorsEditor/index.tsx',
      'src/config/components/editor/PropertySourceEditor/editors/shared.tsx',
      'src/config/components/editor/PropertySourceSelector/index.tsx',
      'src/config/components/editor/TabBar/index.tsx',
      'src/config/components/shared/VirtualTreeRows/index.tsx',
      'src/config/components/themes/ThemeEditor/index.tsx',
      'src/config/components/translations/TranslationsTable/index.tsx',
      'src/hmi/components/ModalStack.tsx',
      'widgets/Content/Icon/index.tsx',
      'widgets/Content/Image/index.tsx',
      'widgets/Layout/FixedSpacer/index.tsx',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
)
