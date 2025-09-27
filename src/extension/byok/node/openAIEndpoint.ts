/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CancellationToken } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ChatEndpoint } from '../../../platform/endpoint/node/chatEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { isOpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { createCapiRequestBody, IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { RawMessageConversionCallback } from '../../../platform/networking/common/openai';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

function hydrateBYOKErrorMessages(response: ChatResponse, logService?: ILogService, requestDetails?: { url: string; headers: Record<string, string>; body?: IEndpointBody }): ChatResponse {
	if (response.type === ChatFetchResponseType.Failed && response.streamError) {
		// Log detailed error information
		if (logService && requestDetails) {
			logService.error('[BYOK API Failure] Request failed with details:');
			logService.error('  URL: ' + requestDetails.url);
			logService.error('  Headers: ' + JSON.stringify(sanitizeHeaders(requestDetails.headers)));
			if (requestDetails.body) {
				logService.error('  Request Body (truncated): ' + JSON.stringify(truncateRequestBody(requestDetails.body), null, 2));
			}
			logService.error('  Stream Error: ' + JSON.stringify(response.streamError));
			logService.error('  Request ID: ' + response.requestId);
			logService.error('  Server Request ID: ' + response.serverRequestId);
		}

		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			reason: JSON.stringify(response.streamError),
			streamError: response.streamError
		};
	} else if (response.type === ChatFetchResponseType.RateLimited) {
		// Log rate limit details
		if (logService && requestDetails) {
			logService.warn('[BYOK Rate Limited] Request was rate limited:');
			logService.warn('  URL: ' + requestDetails.url);
			logService.warn('  Headers: ' + JSON.stringify(sanitizeHeaders(requestDetails.headers)));
			logService.warn('  CAPI Error: ' + JSON.stringify(response.capiError));
			logService.warn('  Request ID: ' + response.requestId);
		}

		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			reason: response.capiError ? 'Rate limit exceeded\n\n' + JSON.stringify(response.capiError) : 'Rate limit exceeded',
			rateLimitKey: '',
			retryAfter: undefined,
			capiError: response.capiError
		};
	} else if (logService && requestDetails) {
		// Log all responses for debugging BUS integration
		logService.info('[BYOK Response Details] Response type: ' + response.type);
		logService.info('[BYOK Response Details] Request URL: ' + requestDetails.url);
		logService.info('[BYOK Response Details] Request Headers: ' + JSON.stringify(sanitizeHeaders(requestDetails.headers)));
	}
	return response;
}

// Helper function to sanitize headers for logging (removes sensitive data)
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
	const sanitized = { ...headers };
	// Mask sensitive header values
	if (sanitized['Authorization']) {
		sanitized['Authorization'] = 'Bearer [REDACTED]';
	}
	if (sanitized['api-key']) {
		sanitized['api-key'] = '[REDACTED]';
	}
	if (sanitized['Cookie']) {
		sanitized['Cookie'] = '[REDACTED]';
	}
	return sanitized;
}

// Helper function to truncate request body for logging
function truncateRequestBody(body: IEndpointBody): any {
	const truncated = { ...body };
	// Truncate messages if they're too long
	if (truncated.messages && Array.isArray(truncated.messages)) {
		truncated.messages = truncated.messages.map((msg: any) => {
			if (msg.content && typeof msg.content === 'string' && msg.content.length > 500) {
				return { ...msg, content: msg.content.substring(0, 500) + '... [TRUNCATED]' };
			}
			return msg;
		});
	}
	return truncated;
}

export class OpenAIEndpoint extends ChatEndpoint {
	private readonly _logService: ILogService;

	constructor(
		protected readonly modelMetadata: IChatModelInformation,
		protected readonly _apiKey: string,
		protected readonly _modelUrl: string,
		@IFetcherService fetcherService: IFetcherService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAuthenticationService authService: IAuthenticationService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@ILogService logService: ILogService
	) {
		super(
			modelMetadata,
			domainService,
			capiClientService,
			fetcherService,
			telemetryService,
			authService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			expService,
			logService
		);
		this._logService = logService;
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		if (this.useResponsesApi) {
			// Handle Responses API: customize the body directly
			options.ignoreStatefulMarker = false;
			const body = super.createRequestBody(options);
			body.store = true;
			body.n = undefined;
			body.stream_options = undefined;
			if (!this.modelMetadata.capabilities.supports.thinking) {
				body.reasoning = undefined;
				body.include = undefined;
			}
			if (body.previous_response_id && !body.previous_response_id.startsWith('resp_')) {
				// Don't use a response ID from CAPI
				body.previous_response_id = undefined;
			}
			return body;
		} else {
			// Handle CAPI: provide callback for thinking data processing
			const callback: RawMessageConversionCallback = (out, data) => {
				if (data && data.id) {
					out.cot_id = data.id;
					out.cot_summary = Array.isArray(data.text) ? data.text.join('') : data.text;
				}
			};
			const body = createCapiRequestBody(options, this.model, callback);
			return body;
		}
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);

		// For BUS models, use the full model name instead of the model ID in the request body
		const isBusModel = this.modelMetadata.id.includes('bus:snap') ||
			(this.modelMetadata.name && this.modelMetadata.name.includes('bus:snap'));

		if (isBusModel && this.modelMetadata.name && body) {
			body.model = this.modelMetadata.name;
		}

		// TODO @lramos15 - We should do this for all models and not just here
		if (body?.tools?.length === 0) {
			delete body.tools;
		}

		if (body?.tools) {
			body.tools = body.tools.map(tool => {
				if (isOpenAiFunctionTool(tool) && tool.function.parameters === undefined) {
					tool.function.parameters = { type: "object", properties: {} };
				}
				return tool;
			});
		}

		if (body) {
			if (this.modelMetadata.capabilities.supports.thinking) {
				delete body.temperature;
				body['max_completion_tokens'] = body.max_tokens;
				delete body.max_tokens;
			}
			// Removing max tokens defaults to the maximum which is what we want for BYOK
			delete body.max_tokens;
			if (!this.useResponsesApi) {
				body['stream_options'] = { 'include_usage': true };
			}
		}
	}

	override get urlOrRequestMetadata(): string {
		return this._modelUrl;
	}

	public getExtraHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

		// Check if model name contains "bus:snap" for special BUS model handling
		// Check both the model ID and the model name field
		const isBusModel = this.modelMetadata.id.includes('bus:snap') ||
			(this.modelMetadata.name && this.modelMetadata.name.includes('bus:snap'));

		if (isBusModel) {
			// For BUS models, pass the API key as a Cookie header and avoid Authorization
			headers['Cookie'] = this._apiKey;
		} else if (this._modelUrl.includes('openai.azure')) {
			headers['api-key'] = this._apiKey;
		} else {
			headers['Authorization'] = `Bearer ${this._apiKey}`;
		}
		return headers;
	}

	override async acceptChatPolicy(): Promise<boolean> {
		return true;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this.modelMetadata, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(OpenAIEndpoint, newModelInfo, this._apiKey, this._modelUrl);
	}

	public override async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		// Apply ignoreStatefulMarker: false for initial request
		const modifiedOptions: IMakeChatRequestOptions = { ...options, ignoreStatefulMarker: false };

		// Capture full request details for logging
		const requestDetails = {
			url: this._modelUrl,
			headers: this.getExtraHeaders(),
			body: undefined as any // Will be populated in hydrateBYOKErrorMessages if needed
		};

		// Log the detailed request information
		this._logService.info('[BYOK Request] =================================');
		this._logService.info('[BYOK Request] Model ID: ' + this.modelMetadata.id);
		this._logService.info('[BYOK Request] Model Name: ' + (this.modelMetadata.name || 'undefined'));
		this._logService.info('[BYOK Request] URL: ' + requestDetails.url);
		this._logService.info('[BYOK Request] Headers: ' + JSON.stringify(sanitizeHeaders(requestDetails.headers)));
		this._logService.info('[BYOK Request] Model contains bus:snap (ID): ' + this.modelMetadata.id.includes('bus:snap'));
		this._logService.info('[BYOK Request] Model contains bus:snap (name): ' + ((this.modelMetadata.name || '').includes('bus:snap')));
		this._logService.info('[BYOK Request] Request options keys: ' + Object.keys(options).join(', '));
		const modelToUse = (this.modelMetadata.id.includes('bus:snap') || (this.modelMetadata.name || '').includes('bus:snap')) && this.modelMetadata.name
			? this.modelMetadata.name
			: this.modelMetadata.id;
		this._logService.info('[BYOK Request] Request body will use model: ' + modelToUse);
		this._logService.info('[BYOK Request] =================================');

		let response = await super.makeChatRequest2(modifiedOptions, token);

		// Log response details
		this._logService.info('[BYOK Response] Type: ' + response.type);
		if (response.type === ChatFetchResponseType.Success) {
			this._logService.info('[BYOK Response] Success - Response length: ' + response.value.length);
		} else {
			this._logService.error('[BYOK Response] Error: ' + JSON.stringify(response));
		}

		if (response.type === ChatFetchResponseType.InvalidStatefulMarker) {
			this._logService.warn('[BYOK] Invalid stateful marker, retrying without marker');
			response = await this._makeChatRequest2({ ...options, ignoreStatefulMarker: true }, token);
		}

		// Enhance error messages with request details and logging
		return hydrateBYOKErrorMessages(response, this._logService, requestDetails);
	}
}
