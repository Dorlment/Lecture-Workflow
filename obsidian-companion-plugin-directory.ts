import { normalizePath, type Plugin } from 'obsidian';

import type {
	CompanionPluginDirectory,
	CompanionPluginDirectoryProvider,
} from './companion-launch-resolver';

export function createObsidianCompanionPluginDirectoryProvider(
	plugin: Pick<Plugin, 'app' | 'manifest'>,
): CompanionPluginDirectoryProvider {
	return {
		getPluginDirectory(): CompanionPluginDirectory | null {
			const manifestDir = plugin.manifest.dir;
			const adapter = plugin.app.vault.adapter;
			if (!manifestDir || !supportsFullPath(adapter)) {
				return null;
			}
			const pluginPath = normalizePath(manifestDir);
			return {
				fullPath: adapter.getFullPath(pluginPath),
				exists: (relativePath) => adapter.exists(
					normalizePath(`${pluginPath}/${relativePath}`),
				),
				resolveFullPath: (relativePath) => adapter.getFullPath(
					normalizePath(`${pluginPath}/${relativePath}`),
				),
			};
		},
	};
}

interface FullPathAdapter {
	exists(normalizedPath: string): Promise<boolean>;
	getFullPath(normalizedPath: string): string;
}

function supportsFullPath(value: unknown): value is FullPathAdapter {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return typeof candidate.exists === 'function'
		&& typeof candidate.getFullPath === 'function';
}
