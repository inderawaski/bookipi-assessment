import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['**/dist/**', '**/node_modules/**', 'playwright-report/**', 'test-results/**', '.pnpm-store/**'] }, js.configs.recommended, ...ts.configs.recommended, { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } } }, { files: ['tests/stress/*.js'], languageOptions: { globals: { __ENV: 'readonly' } } });
