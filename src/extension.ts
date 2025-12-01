// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as ts from 'typescript';
import terminologyData from './data/terms.json';

type BiasSeverity = 'hint' | 'information' | 'warning' | 'error';

interface BiasTerm {
	id: string;
	term: string;
	suggestions?: string[];
	reason: string;
	severity?: BiasSeverity;
	variants?: string[];
}

interface TermOccurrence {
	entry: BiasTerm;
	variant: string;
	index: number;
	length: number;
	matchedText: string;
}

interface NormalizedTerm {
	entry: BiasTerm;
	variant: string;
}

const AST_LANGUAGES = new Set<string>([
	'javascript',
	'javascriptreact',
	'typescript',
	'typescriptreact',
]);

const TEXT_LANGUAGES = new Set<string>([
	'python',
	'java',
]);

const SUPPORTED_LANGUAGES = new Set<string>([
	...Array.from(AST_LANGUAGES),
	...Array.from(TEXT_LANGUAGES),
]);

const biasTerms: BiasTerm[] = terminologyData as BiasTerm[];

const normalizedTerms: NormalizedTerm[] = biasTerms.flatMap((entry) => {
	const variants = [entry.term, ...(entry.variants ?? [])];
	return variants.map((variant) => ({
		entry,
		variant: variant.toLowerCase(),
	}));
});

let diagnosticCollection: vscode.DiagnosticCollection | undefined;

export function activate(context: vscode.ExtensionContext) {
	const collection = vscode.languages.createDiagnosticCollection('bias-linter');
	diagnosticCollection = collection;
	context.subscriptions.push(collection);

	const helloCommand = vscode.commands.registerCommand('bias-linter.helloWorld', () => {
		vscode.window.showInformationMessage('Bias Linter terminology diagnostics are active.');
	});
	context.subscriptions.push(helloCommand);

	const lintVisibleDocument = (document: vscode.TextDocument) => {
		lintDocument(document, collection);
	};

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(lintVisibleDocument),
		vscode.workspace.onDidChangeTextDocument((event) => lintVisibleDocument(event.document)),
		vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
	);

	vscode.workspace.textDocuments.forEach(lintVisibleDocument);
}

export function deactivate() {
	diagnosticCollection?.clear();
}

function lintDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
	if (!SUPPORTED_LANGUAGES.has(document.languageId) || document.uri.scheme === 'output') {
		collection.delete(document.uri);
		return;
	}

	const sourceText = document.getText();
	if (sourceText.trim().length === 0) {
		collection.delete(document.uri);
		return;
	}

	let diagnostics: vscode.Diagnostic[] = [];

	if (AST_LANGUAGES.has(document.languageId)) {
		diagnostics = lintWithAst(document, sourceText);
	} else if (TEXT_LANGUAGES.has(document.languageId)) {
		diagnostics = lintWithText(document, sourceText);
	}

	if (diagnostics.length === 0) {
		collection.delete(document.uri);
		return;
	}

	collection.set(document.uri, diagnostics);
}

function lintWithAst(document: vscode.TextDocument, sourceText: string): vscode.Diagnostic[] {
	const sourceFile = ts.createSourceFile(document.fileName, sourceText, ts.ScriptTarget.Latest, true);
	const diagnostics: vscode.Diagnostic[] = [];

	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node)) {
			collectIdentifierDiagnostics(node, document, sourceFile, diagnostics);
		}

		if (ts.isStringLiteralLike(node)) {
			collectStringDiagnostics(node, document, sourceFile, diagnostics);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return diagnostics;
}

function lintWithText(document: vscode.TextDocument, sourceText: string): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const occurrences = findWholeWordOccurrences(sourceText);
	const seen = new Set<string>();

	for (const occurrence of occurrences) {
		const key = `${occurrence.entry.id}:${occurrence.index}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const range = new vscode.Range(
			document.positionAt(occurrence.index),
			document.positionAt(occurrence.index + occurrence.length),
		);

		diagnostics.push(createDiagnostic(range, occurrence));
	}

	return diagnostics;
}

function collectIdentifierDiagnostics(
	identifier: ts.Identifier,
	document: vscode.TextDocument,
	sourceFile: ts.SourceFile,
	diagnostics: vscode.Diagnostic[],
): void {
	const matches = findTermOccurrences(identifier.text);
	if (matches.length === 0) {
		return;
	}

	const range = new vscode.Range(
		document.positionAt(identifier.getStart(sourceFile)),
		document.positionAt(identifier.getEnd()),
	);

	for (const match of matches) {
		diagnostics.push(createDiagnostic(range, match));
	}
}

function collectStringDiagnostics(
	literal: ts.StringLiteralLike,
	document: vscode.TextDocument,
	sourceFile: ts.SourceFile,
	diagnostics: vscode.Diagnostic[],
): void {
	const matches = findTermOccurrences(literal.text);
	if (matches.length === 0) {
		return;
	}

	const literalStart = literal.getStart(sourceFile) + 1;

	const seen = new Set<string>();
	for (const match of matches) {
		const key = `${match.entry.id}:${match.variant}:${match.index}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const startOffset = literalStart + match.index;
		const endOffset = startOffset + match.length;
		const range = new vscode.Range(
			document.positionAt(startOffset),
			document.positionAt(endOffset),
		);

		diagnostics.push(createDiagnostic(range, match));
	}
}

function findTermOccurrences(value: string): TermOccurrence[] {
	const lowerValue = value.toLowerCase();
	const occurrences: TermOccurrence[] = [];

	for (const term of normalizedTerms) {
		let searchIndex = 0;
		while (searchIndex < lowerValue.length) {
			const index = lowerValue.indexOf(term.variant, searchIndex);
			if (index === -1) {
				break;
			}

			occurrences.push({
				entry: term.entry,
				variant: term.variant,
				index,
				length: term.variant.length,
				matchedText: value.substring(index, index + term.variant.length),
			});

			searchIndex = index + term.variant.length;
		}
	}

	return occurrences;
}

function findWholeWordOccurrences(value: string): TermOccurrence[] {
	const occurrences: TermOccurrence[] = [];

	for (const term of normalizedTerms) {
		const pattern = new RegExp(`\\b${escapeRegExp(term.variant)}\\b`, 'gi');
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(value)) !== null) {
			occurrences.push({
				entry: term.entry,
				variant: term.variant,
				index: match.index,
				length: match[0].length,
				matchedText: match[0],
			});
		}
	}

	return occurrences;
}

function createDiagnostic(range: vscode.Range, match: TermOccurrence): vscode.Diagnostic {
	const severity = toDiagnosticSeverity(match.entry.severity);
	const formattedSuggestions = formatSuggestions(match.entry.suggestions ?? []);
	const messageParts = [
		`"${match.matchedText}" may reinforce biased terminology.`,
	];

	if (formattedSuggestions) {
		messageParts.push(`Consider ${formattedSuggestions}.`);
	}

	messageParts.push(`Why: ${match.entry.reason}`);

	const diagnostic = new vscode.Diagnostic(range, messageParts.join(' '), severity);
	diagnostic.code = match.entry.id;
	diagnostic.source = 'bias-linter';
	return diagnostic;
}

function toDiagnosticSeverity(severity: BiasSeverity | undefined): vscode.DiagnosticSeverity {
	switch (severity) {
		case 'error':
			return vscode.DiagnosticSeverity.Error;
		case 'hint':
			return vscode.DiagnosticSeverity.Hint;
		case 'information':
			return vscode.DiagnosticSeverity.Information;
		case 'warning':
		default:
			return vscode.DiagnosticSeverity.Warning;
	}
}

function formatSuggestions(suggestions: string[]): string {
	if (suggestions.length === 0) {
		return '';
	}

	if (suggestions.length === 1) {
		return `"${suggestions[0]}"`;
	}

	const last = suggestions[suggestions.length - 1];
	const initial = suggestions.slice(0, -1).map((item) => `"${item}"`).join(', ');
	return `${initial} or "${last}"`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
