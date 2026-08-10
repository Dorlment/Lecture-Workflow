import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { build } from 'esbuild';

import {
	REQUIRED_RUNTIME_FILES,
	shouldCopyPublishedPath,
	stageAudioCompanion,
	validatePluginDirectory,
} from '../companion/windows/scripts/stage-audio-companion.mjs';

const bundle = await build({
	stdin: {
		contents: "export * from './companion-launch-resolver.ts';",
		resolveDir: process.cwd(),
		sourcefile: 'audio-companion-discovery-test-entry.ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node18',
	write: false,
});
const source = bundle.outputFiles[0]?.text;
if (!source) throw new Error('Failed to bundle companion resolver.');
const {
	CompanionLaunchResolverError,
	WINDOWS_COMPANION_REQUIRED_FILES,
	createWindowsPluginRelativeLaunchResolver,
} = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('staging and runtime discovery share the same minimum completeness contract', () => {
	assert.deepEqual([...REQUIRED_RUNTIME_FILES], [...WINDOWS_COMPANION_REQUIRED_FILES]);
});

test('plugin-relative resolver validates the minimum runtime and exact launch spec', async () => {
	const checks = [];
	const resolver = createWindowsPluginRelativeLaunchResolver({
		getPluginDirectory: () => ({
			fullPath: 'C:\\vault\\config-dir\\plugins\\lecture-workflow',
			exists: async (relativePath) => {
				checks.push(relativePath);
				return true;
			},
			resolveFullPath: (relativePath) => `C:\\vault\\config-dir\\plugins\\lecture-workflow\\${relativePath.replaceAll('/', '\\')}`,
		}),
	});
	const result = await resolver.resolve(new AbortController().signal);
	assert.deepEqual(checks, WINDOWS_COMPANION_REQUIRED_FILES.map((file) => `companion/windows/${file}`));
	assert.deepEqual(result, {
		executable: 'C:\\vault\\config-dir\\plugins\\lecture-workflow\\companion\\windows\\LectureWorkflow.AudioCompanion.Windows.exe',
		args: ['server', '--token-stdin', '--stop-on-stdin-eof'],
		cwd: 'C:\\vault\\config-dir\\plugins\\lecture-workflow\\companion\\windows',
	});
});

test('resolver returns unavailable for missing or inaccessible runtime files', async () => {
	const missing = createWindowsPluginRelativeLaunchResolver({
		getPluginDirectory: () => ({
			fullPath: 'unused',
			exists: async (path) => !path.endsWith('NAudio.Wasapi.dll'),
			resolveFullPath: (path) => path,
		}),
	});
	assert.equal(await missing.resolve(new AbortController().signal), null);
	const inaccessible = createWindowsPluginRelativeLaunchResolver({
		getPluginDirectory: () => ({
			fullPath: 'unused',
			exists: async () => { throw new Error('private path detail'); },
			resolveFullPath: (path) => path,
		}),
	});
	assert.equal(await inaccessible.resolve(new AbortController().signal), null);
});

test('resolver cancellation interrupts discovery without returning a launch spec', async () => {
	const abort = new AbortController();
	const resolver = createWindowsPluginRelativeLaunchResolver({
		getPluginDirectory: () => ({
			fullPath: 'unused',
			exists: async () => {
				abort.abort();
				return true;
			},
			resolveFullPath: (path) => path,
		}),
	});
	await assert.rejects(
		resolver.resolve(abort.signal),
		(error) => error instanceof CompanionLaunchResolverError && error.code === 'cancelled',
	);
});

test('publish filtering retains runtime dependencies and rejects development artifacts', () => {
	for (const path of [
		'Future.Dependency.dll',
		'runtimes/win-x64/native/future-runtime.dll',
		'helper.json',
	]) assert.equal(shouldCopyPublishedPath(path), true, path);
	for (const path of [
		'helper.pdb',
		'trace.log',
		'source/Helper.cs',
		'obj/project.assets.json',
		'TestResults/result.trx',
		'capture.pcm',
	]) assert.equal(shouldCopyPublishedPath(path), false, path);
});

test('staging copies the actual publish tree, validates the plugin, and leaves data.json untouched', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'lecture-workflow-stage-test-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	const plugin = join(root, 'vault', 'config-dir', 'plugins', 'lecture-workflow');
	await mkdir(join(root, 'repository'), { recursive: true });
	await createPluginDirectory(plugin);
	await writeFile(join(plugin, 'data.json'), '{"private":"unchanged"}', 'utf8');
	const result = await stageAudioCompanion({
		pluginDir: plugin,
		repositoryRoot: join(root, 'repository'),
		temporaryRootFactory: async () => {
			const path = join(root, 'temporary');
			await mkdir(path, { recursive: true });
			return path;
		},
		publishRunner: ({ outputDirectory }) => createPublishOutput(outputDirectory),
	});
	assert.ok(result.files.includes('Future.Dependency.dll'));
	assert.ok(result.files.includes('runtimes/win-x64/native/future-runtime.dll'));
	assert.equal(result.files.some((path) => path.endsWith('.pdb')), false);
	assert.equal(result.files.some((path) => path.includes('TestResults')), false);
	assert.equal(await readFile(join(plugin, 'data.json'), 'utf8'), '{"private":"unchanged"}');
});

test('staging refuses wrong or repository-contained plugin directories', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'lecture-workflow-stage-validation-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, 'repository'), { recursive: true });
	const wrong = join(root, 'wrong');
	await mkdir(wrong, { recursive: true });
	await writeFile(join(wrong, 'manifest.json'), '{"id":"another-plugin"}', 'utf8');
	await writeFile(join(wrong, 'main.js'), '', 'utf8');
	await assert.rejects(validatePluginDirectory(wrong, join(root, 'repository')), /plugin-manifest-id-mismatch/);

	const inside = join(root, 'repository', 'fake-plugin');
	await mkdir(inside, { recursive: true });
	await writeFile(join(inside, 'manifest.json'), '{"id":"lecture-workflow"}', 'utf8');
	await writeFile(join(inside, 'main.js'), '', 'utf8');
	await assert.rejects(validatePluginDirectory(inside, join(root, 'repository')), /plugin-dir-inside-repository/);
});

test('directory exchange failure restores the prior runtime', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'lecture-workflow-stage-rollback-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	const plugin = join(root, 'vault', 'config-dir', 'plugins', 'lecture-workflow');
	await mkdir(join(root, 'repository'), { recursive: true });
	await createPluginDirectory(plugin);
	const destination = join(plugin, 'companion', 'windows');
	await mkdir(destination, { recursive: true });
	await writeFile(join(destination, 'old-runtime.marker'), 'old', 'utf8');
	let exchangeFailed = false;
	await assert.rejects(stageAudioCompanion({
		pluginDir: plugin,
		repositoryRoot: join(root, 'repository'),
		temporaryRootFactory: async () => {
			const path = join(root, 'temporary');
			await mkdir(path, { recursive: true });
			return path;
		},
		publishRunner: ({ outputDirectory }) => createPublishOutput(outputDirectory),
		renamePath: async (sourcePath, destinationPath) => {
			if (!exchangeFailed && sourcePath.includes('.windows-stage-')) {
				exchangeFailed = true;
				throw new Error('simulated-exchange-failure');
			}
			await rename(sourcePath, destinationPath);
		},
	}), /simulated-exchange-failure/);
	assert.equal(await readFile(join(destination, 'old-runtime.marker'), 'utf8'), 'old');
});

async function createPluginDirectory(plugin) {
	await mkdir(plugin, { recursive: true });
	await writeFile(join(plugin, 'manifest.json'), '{"id":"lecture-workflow"}', 'utf8');
	await writeFile(join(plugin, 'main.js'), 'built', 'utf8');
}

async function createPublishOutput(outputDirectory) {
	await mkdir(join(outputDirectory, 'runtimes', 'win-x64', 'native'), { recursive: true });
	for (const file of REQUIRED_RUNTIME_FILES) {
		await writeFile(join(outputDirectory, file), file, 'utf8');
	}
	await writeFile(join(outputDirectory, 'Future.Dependency.dll'), 'future', 'utf8');
	await writeFile(join(outputDirectory, 'debug.pdb'), 'debug', 'utf8');
	await writeFile(join(outputDirectory, 'trace.log'), 'trace', 'utf8');
	await writeFile(join(outputDirectory, 'runtimes', 'win-x64', 'native', 'future-runtime.dll'), 'native', 'utf8');
	await mkdir(join(outputDirectory, 'TestResults'), { recursive: true });
	await writeFile(join(outputDirectory, 'TestResults', 'result.trx'), 'result', 'utf8');
}
