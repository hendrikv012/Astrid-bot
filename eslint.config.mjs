import globals from 'globals';
import pluginEslintJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import configEslintConfigPrettier from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', 'data/**', 'coverage/**'] },
    pluginEslintJs.configs.recommended,
    ...tseslint.configs.recommended,
    {
        name: 'astrid-bot/default/rules',
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/consistent-type-imports': 'error',
        },
    },
    {
        files: ['commitlint.config.cjs'],
        languageOptions: { sourceType: 'commonjs' },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    configEslintConfigPrettier,
);
