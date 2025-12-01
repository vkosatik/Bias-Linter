import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Bias Linter Terminology Diagnostics', () => {
	suiteSetup(() => {
		vscode.window.showInformationMessage('Start bias terminology tests.');
	});

	test('flags biased identifiers', async () => {
		await withDocument('const whitelist = [];', 'typescript', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'terminology.whitelist'),
			);
			const targeted = diagnostics.find((diag) => diag.code === 'terminology.whitelist');
			assert.ok(targeted, 'Expected a diagnostic for the "whitelist" identifier.');
			assert.ok(
				targeted.message.includes('allowlist'),
				'Expected diagnostic message to suggest "allowlist".',
			);
		});
	});

	test('does not flag inclusive terminology', async () => {
		await withDocument('const allowlist = [];', 'typescript', async (document) => {
			await delay(150);
			const diagnostics = vscode.languages.getDiagnostics(document.uri);
			assert.strictEqual(diagnostics.length, 0, 'Expected no diagnostics for inclusive wording.');
		});
	});

	test('flags biased terminology in python source', async () => {
		const pythonSource = [
			'def allocate_access(user):',
			"    whitelist = ['admin']",
		].join('\n');

		await withDocument(pythonSource, 'python', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'terminology.whitelist'),
			);
			assert.ok(diagnostics.length > 0, 'Expected at least one diagnostic in Python file.');
		});
	});

	test('flags biased terminology in java comments', async () => {
		const javaSource = [
			'// quick sanity check before release',
			'public class FeatureFlag {}',
		].join('\n');

		await withDocument(javaSource, 'java', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'terminology.sanity_check'),
			);
			assert.ok(diagnostics.some((diag) => diag.code === 'terminology.sanity_check'));
		});
	});
});

async function withDocument(
	content: string,
	languageId: string,
	run: (document: vscode.TextDocument) => Promise<void>,
): Promise<void> {
	const document = await vscode.workspace.openTextDocument({ language: languageId, content });
	await vscode.window.showTextDocument(document);

	try {
		await run(document);
	} finally {
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	}
}

async function waitForDiagnostics(
	uri: vscode.Uri,
	predicate: (diagnostics: readonly vscode.Diagnostic[]) => boolean,
	timeoutMs = 1000,
): Promise<readonly vscode.Diagnostic[]> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const diagnostics = vscode.languages.getDiagnostics(uri);
		if (predicate(diagnostics)) {
			return diagnostics;
		}
		await delay(50);
	}
	throw new Error('Timed out waiting for diagnostics.');
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
