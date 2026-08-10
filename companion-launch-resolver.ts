import type { CompanionLaunchSpec } from './companion-process-types';

export interface CompanionLaunchResolver {
	resolve(signal: AbortSignal): Promise<CompanionLaunchSpec | null>;
}

export const WINDOWS_COMPANION_DIRECTORY = 'companion/windows';
export const WINDOWS_COMPANION_EXECUTABLE = 'LectureWorkflow.AudioCompanion.Windows.exe';
export const WINDOWS_COMPANION_REQUIRED_FILES = [
	WINDOWS_COMPANION_EXECUTABLE,
	'LectureWorkflow.AudioCompanion.Windows.dll',
	'LectureWorkflow.AudioCompanion.Core.dll',
	'LectureWorkflow.AudioCompanion.Protocol.dll',
	'LectureWorkflow.AudioCompanion.Windows.deps.json',
	'LectureWorkflow.AudioCompanion.Windows.runtimeconfig.json',
	'NAudio.Core.dll',
	'NAudio.Wasapi.dll',
] as const;

export interface CompanionPluginDirectory {
	readonly fullPath: string;
	exists(relativePath: string): Promise<boolean>;
	resolveFullPath(relativePath: string): string;
}

export interface CompanionPluginDirectoryProvider {
	getPluginDirectory(): CompanionPluginDirectory | null;
}

export function createWindowsPluginRelativeLaunchResolver(
	provider: CompanionPluginDirectoryProvider,
): CompanionLaunchResolver {
	return {
		async resolve(signal) {
			throwIfCancelled(signal);
			const pluginDirectory = provider.getPluginDirectory();
			if (!pluginDirectory) {
				return null;
			}
			try {
				for (const file of WINDOWS_COMPANION_REQUIRED_FILES) {
					throwIfCancelled(signal);
					if (!await pluginDirectory.exists(`${WINDOWS_COMPANION_DIRECTORY}/${file}`)) {
						return null;
					}
				}
				throwIfCancelled(signal);
				const cwd = pluginDirectory.resolveFullPath(WINDOWS_COMPANION_DIRECTORY);
				return {
					executable: pluginDirectory.resolveFullPath(
						`${WINDOWS_COMPANION_DIRECTORY}/${WINDOWS_COMPANION_EXECUTABLE}`,
					),
					args: ['server', '--token-stdin', '--stop-on-stdin-eof'],
					cwd,
				};
			} catch (error) {
				throwIfCancelled(signal);
				if (error instanceof CompanionLaunchResolverError) {
					throw error;
				}
				return null;
			}
		},
	};
}

export function createUnavailableCompanionLaunchResolver(): CompanionLaunchResolver {
	return {
		resolve: (signal) => signal.aborted
			? Promise.reject(new CompanionLaunchResolverError('cancelled'))
			: Promise.resolve(null),
	};
}

export function createFixedCompanionLaunchResolver(
	spec: CompanionLaunchSpec,
): CompanionLaunchResolver {
	return {
		resolve: (signal) => signal.aborted
			? Promise.reject(new CompanionLaunchResolverError('cancelled'))
			: Promise.resolve({
				...spec,
				args: [...spec.args],
			}),
	};
}

export class CompanionLaunchResolverError extends Error {
	constructor(readonly code: 'cancelled') {
		super(`Audio companion launch resolution failed: ${code}.`);
		this.name = 'CompanionLaunchResolverError';
	}
}

function throwIfCancelled(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new CompanionLaunchResolverError('cancelled');
	}
}
