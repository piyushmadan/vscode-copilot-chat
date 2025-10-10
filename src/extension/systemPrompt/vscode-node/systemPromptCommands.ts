/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { commands, Disposable, Uri, window, workspace } from 'vscode';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Get the custom system prompt from file (same logic as runtime)
 */
function getCustomSystemPrompt(): { prompt: string; source: 'custom' | 'default' } {
	const DEFAULT_PROMPT = 'You are a highly sophisticated automated coding agent with expert-level knowledge across many different programming languages and frameworks.';

	try {
		const config = workspace.getConfiguration('github.copilot.chat');
		const promptFilePath = (config.get('systemPromptFile') as string || '').trim();

		if (promptFilePath && fs.existsSync(promptFilePath)) {
			const content = fs.readFileSync(promptFilePath, 'utf-8').trim();
			if (content) {
				return { prompt: content, source: 'custom' };
			}
		}
	} catch (err) {
		console.warn('Failed to read custom system prompt:', err);
	}

	return { prompt: DEFAULT_PROMPT, source: 'default' };
}

/**
 * Extract the text content between <Tag name='instructions'> and </Tag> from agentInstructions.tsx
 * @deprecated - Use getCustomSystemPrompt() instead for accurate runtime representation
 */
async function extractCurrentSystemPrompt(workspaceRoot: string): Promise<string | null> {
	const targetPath = workspaceRoot + '/src/extension/prompts/node/agent/agentInstructions.tsx';
	const fileUri = Uri.file(targetPath);

	try {
		const doc = await workspace.openTextDocument(fileUri);
		const full = doc.getText();

		// Find the opening tag
		const startTag = "<Tag name='instructions'>";
		const startIndex = full.indexOf(startTag);
		if (startIndex === -1) {
			window.showErrorMessage('Could not locate <Tag name=\'instructions\'> in agentInstructions.tsx');
			return null;
		}

		const innerStart = startIndex + startTag.length;

		// Find the corresponding closing tag (simple approach: first </Tag> after the opening)
		const endTag = '</Tag>';
		const endIndex = full.indexOf(endTag, innerStart);
		if (endIndex === -1) {
			window.showErrorMessage('Could not find closing </Tag> for instructions in agentInstructions.tsx');
			return null;
		}

		// Extract the content between tags
		const content = full.substring(innerStart, endIndex);
		return content.trim();
	} catch (err) {
		window.showErrorMessage('Failed to read agentInstructions.tsx: ' + String(err));
		return null;
	}
}

/**
 * Command: Preview the current system prompt (shows what's actually being used at runtime)
 */
async function previewCurrentSystemPrompt(): Promise<void> {
	const { prompt, source } = getCustomSystemPrompt();

	// Build preview content with metadata
	const config = workspace.getConfiguration('github.copilot.chat');
	const promptFilePath = (config.get('systemPromptFile') as string || '').trim();

	let header = '';
	if (source === 'custom') {
		header = `# Current System Prompt (Custom)\n\n**Source:** Custom file\n**File Path:** \`${promptFilePath}\`\n\n---\n\n`;
	} else {
		header = `# Current System Prompt (Default)\n\n**Source:** Default prompt (no custom file configured or file not found)\n`;
		if (promptFilePath) {
			header += `**Configured Path:** \`${promptFilePath}\` (file not found or empty)\n`;
		}
		header += `\n**To use a custom prompt:**\n1. Set \`github.copilot.chat.systemPromptFile\` in settings to an absolute file path\n2. Create the file with your custom prompt\n3. Reload VS Code once\n4. Your custom prompt will be used immediately!\n\n---\n\n`;
	}

	const fullContent = header + prompt;

	// Show in a new untitled document
	const doc = await workspace.openTextDocument({
		content: fullContent,
		language: 'markdown'
	});
	await window.showTextDocument(doc, { preview: true });
}

/**
 * Command: Apply system prompt from a configured file to agentInstructions.tsx
 * @deprecated - This command is disabled because it breaks JSX structure. Use hot-reload instead.
 */
async function applySystemPromptFromFile(): Promise<void> {
	const cfg = workspace.getConfiguration('github.copilot.chat');
	const filePath = cfg.get<string>('systemPromptFile', '').trim();
	if (!filePath) {
		window.showErrorMessage('No system prompt file configured. Set github.copilot.chat.systemPromptFile in settings.');
		return;
	}

	const cfgWorkspace = cfg.get<string>('workspaceFolder', '').trim();
	let workspaceRoot: string | undefined = undefined;
	if (cfgWorkspace) {
		workspaceRoot = cfgWorkspace;
	} else {
		workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	if (!workspaceRoot) {
		window.showErrorMessage('No workspace is configured. Set github.copilot.chat.workspaceFolder in settings or open a workspace folder.');
		return;
	}

	// Read the prompt file
	const promptFileUri = Uri.file(filePath);
	let newPromptText: string;
	try {
		const bytes = await workspace.fs.readFile(promptFileUri);
		newPromptText = new TextDecoder('utf-8').decode(bytes).trim();
	} catch (err) {
		window.showErrorMessage('Failed to read system prompt file: ' + String(err));
		return;
	}

	if (!newPromptText) {
		window.showInformationMessage('System prompt file is empty. No changes applied.');
		return;
	}

	// Open agentInstructions.tsx
	const targetPath = workspaceRoot + '/src/extension/prompts/node/agent/agentInstructions.tsx';
	const fileUri = Uri.file(targetPath);

	try {
		const doc = await workspace.openTextDocument(fileUri);
		const full = doc.getText();

		// Find the opening tag
		const startTag = "<Tag name='instructions'>";
		const startIndex = full.indexOf(startTag);
		if (startIndex === -1) {
			window.showErrorMessage('Could not locate <Tag name=\'instructions\'> in agentInstructions.tsx');
			return;
		}

		const innerStart = startIndex + startTag.length;

		// Find the closing tag
		const endTag = '</Tag>';
		const endIndex = full.indexOf(endTag, innerStart);
		if (endIndex === -1) {
			window.showErrorMessage('Could not find closing </Tag> for instructions in agentInstructions.tsx');
			return;
		}

		// Build the new file content - keep everything before innerStart and everything after endIndex (including </Tag>)
		const before = full.substring(0, innerStart);
		const after = full.substring(endIndex); // This includes the closing </Tag> and everything after

		// Format the new prompt text with proper indentation and line breaks
		const formattedPrompt = '\n\t\t\t\t' + newPromptText.split('\n').join('<br />\n\t\t\t\t') + '\n\t\t\t';
		const newContent = before + formattedPrompt + after;

		// Write back to the file
		const fullUri = Uri.file(targetPath);
		await workspace.fs.writeFile(fullUri, Buffer.from(newContent, 'utf-8'));

		window.showInformationMessage('Applied system prompt from file to agentInstructions.tsx');
	} catch (err) {
		window.showErrorMessage('Failed to apply system prompt: ' + String(err));
	}
}

export function create(accessor: any): IDisposable {
	const disposables = new DisposableStore();

	disposables.add(Disposable.from(
		commands.registerCommand('github.copilot.chat.previewCurrentSystemPrompt', previewCurrentSystemPrompt),
		// NOTE: This command is disabled because it breaks the JSX structure in agentInstructions.tsx.
		// Use hot-reload instead: just edit your system_prompt.txt file and it will be applied automatically on next chat request.
		// commands.registerCommand('github.copilot.chat.applySystemPromptFromFile', applySystemPromptFromFile),
	));

	return disposables;
}
