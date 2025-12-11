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

	test('flags biased dataset import in python', async () => {
		const pythonSource = [
			'from sklearn.datasets import load_boston',
			'',
			'def build_model():',
			'	return load_boston()',
		].join('\n');

		await withDocument(pythonSource, 'python', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'supplychain.sklearn.load_boston'),
			);
			assert.ok(
				diagnostics.some((diag) => diag.code === 'supplychain.sklearn.load_boston'),
				'Expected a supply-chain diagnostic for load_boston import.',
			);
		});
	});

	test('flags biased dataset call from aliased import', async () => {
		const pythonSource = [
			'import sklearn.datasets as datasets',
			'',
			'def fetch_data():',
			'	return datasets.load_boston()',
		].join('\n');

		await withDocument(pythonSource, 'python', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'supplychain.sklearn.load_boston'),
			);
			assert.ok(
				diagnostics.some((diag) => diag.code === 'supplychain.sklearn.load_boston'),
				'Expected a supply-chain diagnostic for load_boston call access.',
			);
		});
	});

	test('ignores neutral dataset import in python', async () => {
		const pythonSource = [
			'from sklearn.datasets import load_iris',
			'',
			'def build_model():',
			'	return load_iris()',
		].join('\n');

		await withDocument(pythonSource, 'python', async (document) => {
			await delay(200);
			const diagnostics = vscode.languages.getDiagnostics(document.uri);
			assert.strictEqual(
				diagnostics.length,
				0,
				'Expected no supply-chain diagnostics for neutral dataset import.',
			);
		});
	});

	test('flags hardcoded gender branch logic', async () => {
		const source = [
			'function allocate(user) {',
			"\tif (user.gender === 'female') {",
			"\t\treturn 'pink';",
			'\t}',
			"\treturn 'blue';",
			'}',
		].join('\n');

		await withDocument(source, 'typescript', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'logic.gender_branch'),
			);
			assert.ok(
				diagnostics.some((diag) => diag.code === 'logic.gender_branch'),
				'Expected a structural diagnostic for gender-based branching.',
			);
		});
	});

	test('ignores neutral control flow', async () => {
		const source = [
			'function gate(user) {',
			"\tif (user.role === 'admin') {",
			"\t\treturn 'all';",
			'\t}',
			"\treturn 'limited';",
			'}',
		].join('\n');

		await withDocument(source, 'typescript', async (document) => {
			await delay(200);
			const diagnostics = vscode.languages.getDiagnostics(document.uri);
			assert.strictEqual(
				diagnostics.length,
				0,
				'Expected no diagnostics for non-protected branching logic.',
			);
		});
	});

	test('flags destructured attribute aliases', async () => {
		const source = [
			'function personalize({ gender }) {',
			"\treturn gender !== 'non-binary' ? 'legacy-flow' : 'beta-flow';",
			'}',
		].join('\n');

		await withDocument(source, 'typescript', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'logic.gender_branch'),
			);
			assert.ok(diagnostics.some((diag) => diag.code === 'logic.gender_branch'));
		});
	});

	test('flags age-based range comparisons', async () => {
		const source = [
			'function eligibility(user) {',
			"\tif (user.age >= 65) {",
			"\t\treturn 'vip';",
			'\t}',
			"\treturn 'standard';",
			'}',
		].join('\n');

		await withDocument(source, 'typescript', async (document) => {
			const diagnostics = await waitForDiagnostics(document.uri, (entries) =>
				entries.some((diag) => diag.code === 'logic.age_branch'),
			);
			assert.ok(
				diagnostics.some((diag) => diag.code === 'logic.age_branch'),
				'Expected a structural diagnostic for age gating.',
			);
		});
	});

	test('ignores numeric comparisons on non-protected data', async () => {
		const source = [
			'function budget(user) {',
			"\tif (user.score > 900) {",
			"\t\treturn 'vip';",
			'\t}',
			"\treturn 'standard';",
			'}',
		].join('\n');

		await withDocument(source, 'typescript', async (document) => {
			await delay(200);
			const diagnostics = vscode.languages.getDiagnostics(document.uri);
			assert.strictEqual(diagnostics.length, 0, 'Expected no diagnostics for neutral numeric gate.');
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
