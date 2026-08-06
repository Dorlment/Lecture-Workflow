import { requestUrl } from 'obsidian';

import type { HttpClient, HttpRequest, HttpResponse } from '../provider-types';
import { ProviderError } from '../provider-types';

export class ObsidianHttpClient implements HttpClient {
	async post(request: HttpRequest): Promise<HttpResponse> {
		let timeoutId: number | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timeoutId = window.setTimeout(() => {
				reject(new ProviderError('请求超时，请检查网络或增加超时时间。', 'timeout'));
			}, request.timeoutMs);
		});

		try {
			const response = await Promise.race([
				requestUrl({
					url: request.url,
					method: 'POST',
					contentType: 'application/json',
					headers: request.headers,
					body: request.body,
					throw: false,
				}),
				timeout,
			]);
			return { status: response.status, text: response.text };
		} catch (error) {
			if (error instanceof ProviderError) {
				throw error;
			}
			throw new ProviderError('网络请求失败，请检查网络连接。', 'network');
		} finally {
			if (timeoutId !== undefined) {
				window.clearTimeout(timeoutId);
			}
		}
	}
}
