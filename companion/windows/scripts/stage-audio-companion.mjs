import { spawn } from 'node:child_process';
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_RUNTIME_FILES = Object.freeze([
	'LectureWorkflow.AudioCompanion.Windows.exe',
	'LectureWorkflow.AudioCompanion.Windows.dll',
	'LectureWorkflow.AudioCompanion.Core.dll',
	'LectureWorkflow.AudioCompanion.Protocol.dll',
	'LectureWorkflow.AudioCompanion.Windows.deps.json',
	'LectureWorkflow.AudioCompanion.Windows.runtimeconfig.json',
	'NAudio.Core.dll',
	'NAudio.Wasapi.dll',
]);

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WINDOWS_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const REPOSITORY_ROOT = resolve(WINDOWS_ROOT, '..', '..');
const WINDOWS_PROJECT = join(
	WINDOWS_ROOT,
	'src',
	'LectureWorkflow.AudioCompanion.Windows',
	'LectureWorkflow.AudioCompanion.Windows.csproj',
);

export async function stageAudioCompanion({
	pluginDir,
	publishRunner = runDotnetPublish,
	temporaryRootFactory = () => mkdtemp(join(tmpdir(), 'lecture-workflow-audio-stage-')),
	repositoryRoot = REPOSITORY_ROOT,
	renamePath = rename,
} = {}) {
	const resolvedPluginDir = await validatePluginDirectory(pluginDir, repositoryRoot);
	const temporaryRoot = await temporaryRootFactory();
	const publishDirectory = join(temporaryRoot, 'publish');
	const companionParent = join(resolvedPluginDir, 'companion');
	const destination = join(companionParent, 'windows');
	const stageDirectory = join(companionParent, `.windows-stage-${process.pid}-${Date.now()}`);
	const backupDirectory = join(companionParent, `.windows-backup-${process.pid}-${Date.now()}`);
	let movedExisting = false;
	try {
		await mkdir(publishDirectory, { recursive: true });
		await publishRunner({ outputDirectory: publishDirectory, project: WINDOWS_PROJECT });
		await validateMinimumRuntime(publishDirectory);
		await mkdir(stageDirectory, { recursive: true });
		await copyPublishTree(publishDirectory, stageDirectory);
		await validateMinimumRuntime(stageDirectory);
		await mkdir(companionParent, { recursive: true });
		if (await pathExists(destination)) {
			await renamePath(destination, backupDirectory);
			movedExisting = true;
		}
		try {
			await renamePath(stageDirectory, destination);
		} catch (error) {
			if (movedExisting) {
				await renamePath(backupDirectory, destination);
				movedExisting = false;
			}
			throw error;
		}
		if (movedExisting) {
			await rm(backupDirectory, { recursive: true, force: true });
		}
		return {
			destination,
			files: await listFiles(destination),
		};
	} finally {
		await rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined);
		if (movedExisting && await pathExists(backupDirectory) && !await pathExists(destination)) {
			await renamePath(backupDirectory, destination).catch(() => undefined);
		}
		await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
		await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function validatePluginDirectory(pluginDir, repositoryRoot = REPOSITORY_ROOT) {
	if (typeof pluginDir !== 'string' || !isAbsolute(pluginDir)) {
		throw new Error('plugin-dir-must-be-absolute');
	}
	const resolved = await realpath(resolve(pluginDir));
	const repo = await realpath(resolve(repositoryRoot));
	const relation = relative(repo, resolved);
	if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) {
		throw new Error('plugin-dir-inside-repository');
	}
	const manifest = JSON.parse(await readFile(join(resolved, 'manifest.json'), 'utf8'));
	if (manifest?.id !== 'lecture-workflow') {
		throw new Error('plugin-manifest-id-mismatch');
	}
	const mainInfo = await stat(join(resolved, 'main.js'));
	if (!mainInfo.isFile()) {
		throw new Error('plugin-main-missing');
	}
	return resolved;
}

export async function validateMinimumRuntime(directory) {
	for (const file of REQUIRED_RUNTIME_FILES) {
		const info = await stat(join(directory, file)).catch(() => null);
		if (!info?.isFile()) {
			throw new Error(`runtime-incomplete:${file}`);
		}
	}
}

export function shouldCopyPublishedPath(relativePath) {
	const segments = relativePath.split(/[\\/]+/u).map((part) => part.toLowerCase());
	const blockedSegments = new Set(['obj', 'testresults', 'artifacts', 'publish', 'source', 'sources']);
	if (segments.some((segment) => blockedSegments.has(segment))) {
		return false;
	}
	const name = segments.at(-1) ?? '';
	return !(/\.(?:pdb|cs|fs|vb|log|tmp|temp|wav|pcm|mp3|flac)$/iu.test(name)
		|| /(?:^|[-_.])(?:debug|trace)(?:[-_.]|$)/iu.test(name));
}

async function copyPublishTree(source, destination, relativePath = '') {
	for (const entry of await readdir(join(source, relativePath), { withFileTypes: true })) {
		const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
		if (!shouldCopyPublishedPath(childRelative)) {
			continue;
		}
		const sourcePath = join(source, childRelative);
		const destinationPath = join(destination, childRelative);
		if (entry.isDirectory()) {
			await mkdir(destinationPath, { recursive: true });
			await copyPublishTree(source, destination, childRelative);
		} else if (entry.isFile()) {
			await mkdir(dirname(destinationPath), { recursive: true });
			await cp(sourcePath, destinationPath);
		}
	}
}

async function listFiles(root, relativePath = '') {
	const files = [];
	for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
		const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
		if (entry.isDirectory()) {
			files.push(...await listFiles(root, childRelative));
		} else if (entry.isFile()) {
			files.push(childRelative.replaceAll('\\', '/'));
		}
	}
	return files.sort();
}

async function runDotnetPublish({ outputDirectory, project }) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn('dotnet', [
			'publish',
			project,
			'-c',
			'Release',
			'--no-self-contained',
			'--output',
			outputDirectory,
		], { stdio: 'inherit', windowsHide: true });
		child.once('error', () => reject(new Error('dotnet-publish-launch-failed')));
		child.once('exit', (code) => {
			if (code === 0) {
				resolvePromise();
			} else {
				reject(new Error('dotnet-publish-failed'));
			}
		});
	});
}

async function pathExists(path) {
	return stat(path).then(() => true, () => false);
}

function parsePluginDir(argv) {
	const index = argv.indexOf('--plugin-dir');
	if (index < 0 || !argv[index + 1] || argv.length !== 2) {
		throw new Error('usage: --plugin-dir <absolute-plugin-directory>');
	}
	return argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	stageAudioCompanion({ pluginDir: parsePluginDir(process.argv.slice(2)) })
		.then(({ destination, files }) => {
			console.log(`Audio Companion staged to: ${destination}`);
			for (const file of files) console.log(`- ${file}`);
		})
		.catch((error) => {
			console.error(`Audio Companion staging failed: ${error instanceof Error ? error.message : 'unknown'}`);
			process.exitCode = 1;
		});
}
