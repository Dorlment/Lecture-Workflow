import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'tests/*.test.mjs',
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.ts'],
		rules: {
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					brands: ['Lecture Workflow', 'Obsidian', 'DeepSeek', 'Qwen', 'OpenAI', 'Workspace', 'Markdown', 'Provider', 'Token'],
					acronyms: ['AI', 'API', 'URL', 'ID', 'OK', 'VPN'],
					enforceCamelCaseLower: true,
				},
			],
		},
	},
	{
		files: ['tests/**/*.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'no-unsanitized/method': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
);
