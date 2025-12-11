import * as vscode from 'vscode';
import * as ts from 'typescript';
import terminologyData from './data/terms.json';
import datasetData from './data/datasets.json';

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

interface ProtectedAttributeRule {
	id: string;
	attribute: string;
	synonyms: string[];
	reason: string;
	suggestions?: string[];
	severity?: BiasSeverity;
	supportsRangeComparisons?: boolean;
}

interface StructuralMatch {
	rule: ProtectedAttributeRule;
	attributeText: string;
	literalText?: string;
	comparisonType: 'equality' | 'range' | 'case' | 'membership';
	operatorText?: string;
	node?: ts.Node;
}

interface DatasetRule {
	id: string;
	language: string;
	module?: string;
	symbols?: string[];
	reason: string;
	suggestions?: string[];
	severity?: BiasSeverity;
}

type AttributeBinding = { rule: ProtectedAttributeRule; text: string };
type AttributeAliasMap = Map<string, AttributeBinding>;

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

const datasetRules: DatasetRule[] = datasetData as DatasetRule[];
const datasetRulesByLanguage = new Map<string, DatasetRule[]>();
for (const rule of datasetRules) {
	const key = rule.language.toLowerCase();
	const bucket = datasetRulesByLanguage.get(key);
	if (bucket) {
		bucket.push(rule);
	} else {
		datasetRulesByLanguage.set(key, [rule]);
	}
}

const PROTECTED_ATTRIBUTE_RULES: ProtectedAttributeRule[] = [
	{
		id: 'logic.gender_branch',
		attribute: 'gender',
		synonyms: ['gender', 'sex'],
		reason:
			'Hardcoding binary gender checks can exclude non-binary identities and propagate allocative harm.',
		suggestions: ['Gate access on capability-based signals instead of gender'],
		severity: 'warning',
	},
	{
		id: 'logic.race_branch',
		attribute: 'race',
		synonyms: ['race', 'ethnicity'],
		reason: 'Race or ethnicity specific branches can reinforce discriminatory treatment.',
		suggestions: ['Use location or qualification based inputs rather than racial categories'],
		severity: 'warning',
	},
	{
		id: 'logic.religion_branch',
		attribute: 'religion',
		synonyms: ['religion', 'faith'],
		reason: 'Religion-specific control flow may violate inclusion policies.',
		suggestions: ['Favor behavior or consent signals over religious identity'],
		severity: 'warning',
	},
	{
		id: 'logic.orientation_branch',
		attribute: 'sexual orientation',
		synonyms: ['orientation', 'sexualorientation', 'sexual_orientation'],
		reason: 'Encoding outcomes by sexual orientation can entrench bias and privacy leaks.',
		suggestions: ['Avoid branching on sexual orientation; prefer voluntary preference settings'],
		severity: 'warning',
	},
	{
		id: 'logic.age_branch',
		attribute: 'age',
		synonyms: ['age'],
		reason: 'Age based gates require legal review to avoid disparate impact.',
		suggestions: ['Lean on regulatory compliance services or dynamic eligibility checks'],
		severity: 'information',
		supportsRangeComparisons: true,
	},
	{
		id: 'logic.disability_branch',
		attribute: 'disability status',
		synonyms: ['disability', 'abilitystatus', 'ability_status'],
		reason: 'Routing by disability can violate accessibility norms.',
		suggestions: ['Offer self-service accommodations instead of branching logic'],
		severity: 'warning',
	},
];

const protectedAttributeLookup = new Map<string, ProtectedAttributeRule>();
for (const rule of PROTECTED_ATTRIBUTE_RULES) {
	for (const synonym of rule.synonyms) {
		protectedAttributeLookup.set(normalizeAttributeKey(synonym), rule);
	}
}

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
	const attributeAliases = collectAttributeAliases(sourceFile);

	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node)) {
			collectIdentifierDiagnostics(node, document, sourceFile, diagnostics);
		}

		if (ts.isStringLiteralLike(node)) {
			collectStringDiagnostics(node, document, sourceFile, diagnostics);
		}

		if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node)) {
			collectStructuralLogicDiagnostics(node, document, sourceFile, diagnostics, attributeAliases);
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

	if (document.languageId === 'python') {
		diagnostics.push(...lintPythonStructural(document, sourceText));
		diagnostics.push(...lintPythonSupplyChain(document, sourceText));
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

function collectStructuralLogicDiagnostics(
	node: ts.IfStatement | ts.ConditionalExpression | ts.SwitchStatement,
	document: vscode.TextDocument,
	sourceFile: ts.SourceFile,
	diagnostics: vscode.Diagnostic[],
	attributeAliases: AttributeAliasMap,
): void {
	if (ts.isIfStatement(node)) {
		const matches = findProtectedAttributeComparisons(node.expression, sourceFile, attributeAliases);
		for (const match of matches) {
			if (!match.node) {
				continue;
			}
			const range = new vscode.Range(
				document.positionAt(match.node.getStart(sourceFile)),
				document.positionAt(match.node.getEnd()),
			);
			diagnostics.push(createStructuralDiagnostic(range, match));
		}
		return;
	}

	if (ts.isConditionalExpression(node)) {
		const matches = findProtectedAttributeComparisons(node.condition, sourceFile, attributeAliases);
		for (const match of matches) {
			if (!match.node) {
				continue;
			}
			const range = new vscode.Range(
				document.positionAt(match.node.getStart(sourceFile)),
				document.positionAt(match.node.getEnd()),
			);
			diagnostics.push(createStructuralDiagnostic(range, match));
		}
		return;
	}

	if (ts.isSwitchStatement(node)) {
		const attribute = getAttributeBinding(node.expression, sourceFile, attributeAliases);
		if (!attribute) {
			return;
		}

		for (const clause of node.caseBlock.clauses) {
			if (!ts.isCaseClause(clause) || !clause.expression) {
				continue;
			}

			const literalText = getLiteralValue(clause.expression) ?? clause.expression.getText(sourceFile);
			const range = new vscode.Range(
				document.positionAt(clause.expression.getStart(sourceFile)),
				document.positionAt(clause.expression.getEnd()),
			);
			diagnostics.push(
				createStructuralDiagnostic(range, {
					rule: attribute.rule,
					attributeText: attribute.text,
					literalText,
					node: clause.expression,
					comparisonType: 'case',
				}),
			);
		}
	}
}

function findProtectedAttributeComparisons(
	expression: ts.Expression,
	sourceFile: ts.SourceFile,
	attributeAliases: AttributeAliasMap,
): StructuralMatch[] {
	const matches: StructuralMatch[] = [];

	const visit = (current: ts.Node) => {
		if (!ts.isBinaryExpression(current)) {
			ts.forEachChild(current, visit);
			return;
		}

		const operatorKind = current.operatorToken.kind;
		const operatorText = current.operatorToken.getText(sourceFile);

		if (isEqualityOperator(operatorKind)) {
			const left = getAttributeBinding(current.left, sourceFile, attributeAliases);
			const right = getAttributeBinding(current.right, sourceFile, attributeAliases);
			const leftLiteral = getLiteralValue(current.left);
			const rightLiteral = getLiteralValue(current.right);

			if (left && rightLiteral !== undefined) {
				matches.push({
					rule: left.rule,
					attributeText: left.text,
					literalText: rightLiteral,
					node: current,
					comparisonType: 'equality',
					operatorText,
				});
			}

			if (right && leftLiteral !== undefined) {
				matches.push({
					rule: right.rule,
					attributeText: right.text,
					literalText: leftLiteral,
					node: current,
					comparisonType: 'equality',
					operatorText,
				});
			}
		} else if (isRangeComparisonOperator(operatorKind)) {
			const left = getAttributeBinding(current.left, sourceFile, attributeAliases);
			const right = getAttributeBinding(current.right, sourceFile, attributeAliases);
			const leftNumeric = getNumericLiteralText(current.left);
			const rightNumeric = getNumericLiteralText(current.right);

			if (left && rightNumeric !== undefined && left.rule.supportsRangeComparisons) {
				matches.push({
					rule: left.rule,
					attributeText: left.text,
					literalText: rightNumeric,
					node: current,
					comparisonType: 'range',
					operatorText,
				});
			}

			if (right && leftNumeric !== undefined && right.rule.supportsRangeComparisons) {
				matches.push({
					rule: right.rule,
					attributeText: right.text,
					literalText: leftNumeric,
					node: current,
					comparisonType: 'range',
					operatorText,
				});
			}
		}

		ts.forEachChild(current, visit);
	};

	visit(expression);
	return matches;
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

function lintPythonStructural(document: vscode.TextDocument, sourceText: string): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const aliasMap = collectPythonAttributeAliases(sourceText);
	const statementPattern = /\b(if|elif|while)\s+([^:\n]+)\s*:/g;
	const seen = new Set<string>();
	let statementMatch: RegExpExecArray | null;

	while ((statementMatch = statementPattern.exec(sourceText)) !== null) {
		const fullMatch = statementMatch[0];
		const conditionText = statementMatch[2];
		if (!conditionText) {
			continue;
		}

		const conditionIndexInMatch = fullMatch.indexOf(conditionText);
		if (conditionIndexInMatch === -1) {
			continue;
		}

		const conditionStartInDoc = statementMatch.index + conditionIndexInMatch;
		const comparisonPattern = /([^&|]+?)\s*(==|!=|<=|>=|<|>)\s*([^&|]+?)(?=\s*(?:and|or|$))/g;
		let comparisonMatch: RegExpExecArray | null;

		while ((comparisonMatch = comparisonPattern.exec(conditionText)) !== null) {
			const rawLeft = comparisonMatch[1] ?? '';
			const operatorText = comparisonMatch[2];
			const rawRight = comparisonMatch[3] ?? '';
			const rawComparison = comparisonMatch[0];
			const trimmedComparison = rawComparison.trim();
			const leadingWhitespace = rawComparison.length - rawComparison.trimStart().length;
			const comparisonOffset = conditionStartInDoc + comparisonMatch.index + leadingWhitespace;
			const comparisonLength = trimmedComparison.length;
			const rangeStart = document.positionAt(comparisonOffset);
			const rangeEnd = document.positionAt(comparisonOffset + comparisonLength);
			const range = new vscode.Range(rangeStart, rangeEnd);

			const leftText = stripEnclosingParens(rawLeft.trim());
			const rightText = stripEnclosingParens(rawRight.trim());
			const leftBinding = resolvePythonAttributeBinding(leftText, aliasMap);
			const rightBinding = resolvePythonAttributeBinding(rightText, aliasMap);
			const leftLiteral = parsePythonLiteral(leftText);
			const rightLiteral = parsePythonLiteral(rightText);
			const comparisonType = isRangeOperatorText(operatorText) ? 'range' : 'equality';

			if (leftBinding && rightLiteral !== undefined) {
				if (comparisonType === 'range' && !leftBinding.rule.supportsRangeComparisons) {
					// Skip range comparisons for rules that do not support them.
				} else {
					const key = `${leftBinding.rule.id}:${comparisonOffset}:${rightLiteral}:${operatorText}`;
					if (!seen.has(key)) {
						seen.add(key);
						diagnostics.push(
							createStructuralDiagnostic(range, {
								rule: leftBinding.rule,
								attributeText: leftBinding.text,
								literalText: rightLiteral,
								comparisonType,
								operatorText,
							}),
						);
					}
				}
			}

			if (rightBinding && leftLiteral !== undefined) {
				if (comparisonType === 'range' && !rightBinding.rule.supportsRangeComparisons) {
					continue;
				}
				const key = `${rightBinding.rule.id}:${comparisonOffset}:${leftLiteral}:${operatorText}`;
				if (!seen.has(key)) {
					seen.add(key);
					diagnostics.push(
						createStructuralDiagnostic(range, {
							rule: rightBinding.rule,
							attributeText: rightBinding.text,
							literalText: leftLiteral,
							comparisonType,
							operatorText,
						}),
					);
				}
			}
		}

		const membershipPattern = /([^&|]+?)\s+(not\s+in|in)\s+([^&|]+?)(?=\s*(?:and|or|$))/g;
		let membershipMatch: RegExpExecArray | null;
		while ((membershipMatch = membershipPattern.exec(conditionText)) !== null) {
			const rawLeft = membershipMatch[1] ?? '';
			const operatorText = membershipMatch[2];
			const rawRight = membershipMatch[3] ?? '';
			const rawComparison = membershipMatch[0];
			const trimmedComparison = rawComparison.trim();
			const leadingWhitespace = rawComparison.length - rawComparison.trimStart().length;
			const comparisonOffset = conditionStartInDoc + membershipMatch.index + leadingWhitespace;
			const comparisonLength = trimmedComparison.length;
			const rangeStart = document.positionAt(comparisonOffset);
			const rangeEnd = document.positionAt(comparisonOffset + comparisonLength);
			const range = new vscode.Range(rangeStart, rangeEnd);

			const normalizedOperator = operatorText.replace(/\s+/g, ' ');
			const leftText = stripEnclosingParens(rawLeft.trim());
			const rightText = stripEnclosingParens(rawRight.trim());
			const leftBinding = resolvePythonAttributeBinding(leftText, aliasMap);
			const rightBinding = resolvePythonAttributeBinding(rightText, aliasMap);
			const leftLiteral = parsePythonLiteral(leftText);
			const rightLiteral = parsePythonLiteral(rightText);
			const leftCollection = summarizePythonCollectionLiteral(leftText);
			const rightCollection = summarizePythonCollectionLiteral(rightText);

			if (leftBinding && (rightLiteral !== undefined || rightCollection)) {
				const literalValue = rightCollection ?? rightLiteral ?? rightText;
				const key = `${leftBinding.rule.id}:membership:${comparisonOffset}:${literalValue}:${normalizedOperator}`;
				if (!seen.has(key)) {
					seen.add(key);
					diagnostics.push(
						createStructuralDiagnostic(range, {
							rule: leftBinding.rule,
							attributeText: leftBinding.text,
							literalText: literalValue,
							comparisonType: 'membership',
							operatorText: normalizedOperator,
						}),
					);
				}
			}

			if (rightBinding && (leftLiteral !== undefined || leftCollection)) {
				const literalValue = leftCollection ?? leftLiteral ?? leftText;
				const key = `${rightBinding.rule.id}:membership:${comparisonOffset}:${literalValue}:${normalizedOperator}`;
				if (!seen.has(key)) {
					seen.add(key);
					diagnostics.push(
						createStructuralDiagnostic(range, {
							rule: rightBinding.rule,
							attributeText: rightBinding.text,
							literalText: literalValue,
							comparisonType: 'membership',
							operatorText: normalizedOperator,
						}),
					);
				}
			}
		}
	}

	diagnostics.push(...lintPythonMatchStatements(document, sourceText, aliasMap));

	return diagnostics;
}

function lintPythonSupplyChain(document: vscode.TextDocument, sourceText: string): vscode.Diagnostic[] {
	const rules = datasetRulesByLanguage.get('python');
	if (!rules || rules.length === 0) {
		return [];
	}

	const diagnostics: vscode.Diagnostic[] = [];
	const lines = sourceText.split(/\r?\n/);
	const seen = new Set<string>();

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		const trimmed = line.trim();
		if (trimmed.startsWith('#') || trimmed.length === 0) {
			continue;
		}

		const fromMatch = line.match(/^(\s*)from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/);
		if (fromMatch) {
			const [, leadingWhitespace, moduleName, importedSection] = fromMatch;
			const relevantRules = rules.filter((rule) => rule.module === moduleName);
			if (relevantRules.length === 0) {
				continue;
			}

			const parts = importedSection.split(',');
			let searchCursor = 0;
			for (const part of parts) {
				const rawPart = part.trim();
				if (rawPart.length === 0) {
					continue;
				}

				const [symbolName] = rawPart.split(/\s+as\s+/);
				const matchingRule = relevantRules.find((rule) => (rule.symbols ?? []).includes(symbolName));
				if (!matchingRule) {
					searchCursor += part.length + 1;
					continue;
				}

				const partIndex = line.indexOf(rawPart, searchCursor);
				const startColumn = partIndex === -1 ? leadingWhitespace.length + `from ${moduleName} import `.length : partIndex;
				const endColumn = startColumn + rawPart.length;
				const range = new vscode.Range(new vscode.Position(lineIndex, startColumn), new vscode.Position(lineIndex, endColumn));
				const key = `${matchingRule.id}:from:${lineIndex}:${startColumn}`;
				if (seen.has(key)) {
					searchCursor += part.length + 1;
					continue;
				}
				seen.add(key);

				diagnostics.push(
					createDatasetDiagnostic(range, matchingRule, {
						moduleName,
						symbolName,
						matchedText: rawPart,
						sourceType: 'import',
					}),
				);
				searchCursor += part.length + 1;
			}

			continue;
		}

		const importMatch = line.match(/^(\s*)import\s+(.+)$/);
		if (importMatch) {
			const [, leadingWhitespace, importedSection] = importMatch;
			const parts = importedSection.split(',');
			let searchCursor = 0;
			for (const part of parts) {
				const rawPart = part.trim();
				if (rawPart.length === 0) {
					continue;
				}

				const [moduleName] = rawPart.split(/\s+as\s+/);
				const matchingRule = rules.find((rule) => rule.module === moduleName && (!rule.symbols || rule.symbols.length === 0));
				if (!matchingRule) {
					searchCursor += part.length + 1;
					continue;
				}

				const partIndex = line.indexOf(rawPart, searchCursor);
				const startColumn = partIndex === -1 ? leadingWhitespace.length + 'import '.length : partIndex;
				const endColumn = startColumn + rawPart.length;
				const range = new vscode.Range(new vscode.Position(lineIndex, startColumn), new vscode.Position(lineIndex, endColumn));
				const key = `${matchingRule.id}:import:${lineIndex}:${startColumn}`;
				if (seen.has(key)) {
					searchCursor += part.length + 1;
					continue;
				}
				seen.add(key);

				diagnostics.push(
					createDatasetDiagnostic(range, matchingRule, {
						moduleName,
						matchedText: rawPart,
						sourceType: 'import',
					}),
				);
				searchCursor += part.length + 1;
			}

			continue;
		}

		for (const rule of rules) {
			if (!rule.symbols || rule.symbols.length === 0) {
				continue;
			}
			for (const symbolName of rule.symbols) {
				const callPattern = new RegExp(`(?:^|[^A-Za-z0-9_])(${escapeRegExp(symbolName)})\\s*\\(`);
				const callMatch = callPattern.exec(line);
				if (!callMatch) {
					continue;
				}

				const matchedText = callMatch[1];
				const startColumn = callMatch.index + (callMatch[0].length - callMatch[1].length);
				const endColumn = startColumn + matchedText.length;
				const range = new vscode.Range(new vscode.Position(lineIndex, startColumn), new vscode.Position(lineIndex, endColumn));
				const key = `${rule.id}:call:${lineIndex}:${startColumn}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);

				diagnostics.push(
					createDatasetDiagnostic(range, rule, {
						symbolName,
						matchedText,
						sourceType: 'call',
					}),
				);
			}
		}
	}

	return diagnostics;
}

function lintPythonMatchStatements(
	document: vscode.TextDocument,
	sourceText: string,
	aliasMap: AttributeAliasMap,
): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const lines = sourceText.split(/\r?\n/);
	const seen = new Set<string>();

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		const trimmed = line.trim();
		if (!trimmed.startsWith('match ')) {
			continue;
		}

		const indentMatch = line.match(/^\s*/);
		const indent = indentMatch ? indentMatch[0] : '';
		const expressionText = trimmed.slice('match '.length).replace(/:$/, '').trim();
		if (expressionText.length === 0) {
			continue;
		}

		const attributeBinding = resolvePythonAttributeBinding(expressionText, aliasMap);
		if (!attributeBinding) {
			continue;
		}

		for (let lookahead = lineIndex + 1; lookahead < lines.length; lookahead += 1) {
			const candidateLine = lines[lookahead];
			const candidateTrimmed = candidateLine.trim();
			const candidateIndentMatch = candidateLine.match(/^\s*/);
			const candidateIndent = candidateIndentMatch ? candidateIndentMatch[0] : '';

			if (candidateTrimmed.length === 0) {
				continue;
			}

			if (candidateIndent.length <= indent.length && !candidateTrimmed.startsWith('case ')) {
				break;
			}

			if (!candidateTrimmed.startsWith('case ')) {
				continue;
			}

			const caseBody = candidateTrimmed.slice('case '.length);
			const colonIndex = caseBody.indexOf(':');
			let rawPattern = colonIndex === -1 ? caseBody : caseBody.slice(0, colonIndex);
			rawPattern = rawPattern.trim();
			if (rawPattern.length === 0 || rawPattern === '_') {
				continue;
			}

			const guardIndex = rawPattern.indexOf(' if ');
			if (guardIndex !== -1) {
				rawPattern = rawPattern.slice(0, guardIndex).trim();
			}

			const literal = parsePythonLiteral(rawPattern);
			if (literal === undefined) {
				continue;
			}

			const caseColumn = candidateLine.indexOf('case ');
			const patternLeadingWhitespace = caseBody.length - caseBody.trimStart().length;
			const patternColumn = caseColumn + 'case '.length + patternLeadingWhitespace;
			const patternLength = rawPattern.length;
			const rangeStart = new vscode.Position(lookahead, patternColumn);
			const rangeEnd = new vscode.Position(lookahead, patternColumn + patternLength);
			const range = new vscode.Range(rangeStart, rangeEnd);

			const key = `${attributeBinding.rule.id}:match:${lookahead}:${patternColumn}:${literal}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			diagnostics.push(
				createStructuralDiagnostic(range, {
					rule: attributeBinding.rule,
					attributeText: attributeBinding.text,
					literalText: literal,
					comparisonType: 'case',
					operatorText: 'match',
				}),
			);
		}
	}

	return diagnostics;
}

function collectPythonAttributeAliases(sourceText: string): AttributeAliasMap {
	const aliases: AttributeAliasMap = new Map();
	const assignmentPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/gm;
	let match: RegExpExecArray | null;

	while ((match = assignmentPattern.exec(sourceText)) !== null) {
		const identifier = match[1];
		const expression = stripInlineComment(match[2]);
		const binding = resolveDirectPythonAttributeBinding(expression);
		if (binding) {
			aliases.set(identifier, binding);
		}
	}

	return aliases;
}

function stripInlineComment(value: string): string {
	const hashIndex = value.indexOf('#');
	if (hashIndex === -1) {
		return value.trim();
	}
	return value.slice(0, hashIndex).trimEnd();
}

function stripEnclosingParens(value: string): string {
	let result = value.trim();
	while (result.startsWith('(') && result.endsWith(')')) {
		const inner = result.slice(1, -1);
		if (!hasBalancedParentheses(inner)) {
			break;
		}
		result = inner.trim();
	}
	while (result.endsWith(')') && !hasBalancedParentheses(result)) {
		result = result.slice(0, -1).trimEnd();
	}
	return result;
}

function hasBalancedParentheses(value: string): boolean {
	let depth = 0;
	for (const char of value) {
		if (char === '(') {
			depth += 1;
		} else if (char === ')') {
			if (depth === 0) {
				return false;
			}
			depth -= 1;
		}
	}
	return depth === 0;
}

function resolvePythonAttributeBinding(
	expressionText: string,
	aliases?: AttributeAliasMap,
): AttributeBinding | undefined {
	const trimmed = expressionText.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	if (aliases) {
		const directAlias = aliases.get(trimmed);
		if (directAlias) {
			return directAlias;
		}

		const simpleIdentifierMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
		if (simpleIdentifierMatch) {
			const alias = aliases.get(simpleIdentifierMatch[0]);
			if (alias) {
				return alias;
			}
		}
	}

	return resolveDirectPythonAttributeBinding(trimmed);
}

function resolveDirectPythonAttributeBinding(expressionText: string): AttributeBinding | undefined {
	const trimmed = expressionText.trim();
	if (trimmed.length === 0 || isPythonLiteral(trimmed)) {
		return undefined;
	}

	const identifierPattern = /[A-Za-z_][A-Za-z0-9_]*/g;
	const visited = new Set<string>();
	let match: RegExpExecArray | null;

	while ((match = identifierPattern.exec(trimmed)) !== null) {
		const token = match[0];
		if (visited.has(token)) {
			continue;
		}
		visited.add(token);

		const rule = matchPythonTokenToRule(token);
		if (rule) {
			return { rule, text: trimmed };
		}
	}

	return undefined;
}

function matchPythonTokenToRule(token: string): ProtectedAttributeRule | undefined {
	const direct = protectedAttributeLookup.get(normalizeAttributeKey(token));
	if (direct) {
		return direct;
	}

	const pieces = token.split(/_|(?=[A-Z])/g).filter((piece) => piece.length > 0);
	for (const piece of pieces) {
		const rule = protectedAttributeLookup.get(normalizeAttributeKey(piece));
		if (rule) {
			return rule;
		}
	}

	return undefined;
}

function parsePythonLiteral(expressionText: string): string | undefined {
	const trimmed = expressionText.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		if (trimmed.length >= 2) {
			return trimmed.slice(1, -1);
		}
		return '';
	}

	if (/^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) {
		return trimmed;
	}

	if (trimmed === 'True' || trimmed === 'False' || trimmed === 'None') {
		return trimmed;
	}

	return undefined;
}

function isPythonLiteral(expressionText: string): boolean {
	return parsePythonLiteral(expressionText) !== undefined;
}

function summarizePythonCollectionLiteral(expressionText: string): string | undefined {
	const trimmed = expressionText.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
		return trimmed;
	}

	const wrapperMatch = trimmed.match(/^(set|list|tuple|frozenset)\((.*)\)$/i);
	const inner = wrapperMatch ? wrapperMatch[2] : trimmed;
	const strings = Array.from(inner.matchAll(/(['"])(.*?)\1/g)).map((match) => match[2]).filter((value) => value.length > 0);
	if (strings.length > 0) {
		const preview = strings.slice(0, 3).join(', ');
		return strings.length > 3 ? `${preview}, ...` : preview;
	}

	const numbers = inner.match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
	if (numbers.length > 0) {
		const preview = numbers.slice(0, 3).join(', ');
		return numbers.length > 3 ? `${preview}, ...` : preview;
	}

	if (/^[\[\{\(].*[\]\}\)]$/.test(trimmed)) {
		return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 37)}...`;
	}

	return undefined;
}

function isRangeOperatorText(operator: string): boolean {
	switch (operator) {
		case '>=':
		case '>':
		case '<=':
		case '<':
			return true;
		default:
			return false;
	}
}

function collectAttributeAliases(sourceFile: ts.SourceFile): AttributeAliasMap {
	const aliases: AttributeAliasMap = new Map();

	const registerAlias = (identifier: ts.Identifier, binding: AttributeBinding) => {
		if (!aliases.has(identifier.text)) {
			aliases.set(identifier.text, binding);
		}
	};

	const handleBindingPattern = (pattern: ts.ObjectBindingPattern) => {
		for (const element of pattern.elements) {
			if (!ts.isIdentifier(element.name)) {
				continue;
			}

			const propertyNode = element.propertyName ?? element.name;
			const propertyText = getBindingPropertyText(propertyNode);
			if (!propertyText) {
				continue;
			}

			const rule = protectedAttributeLookup.get(normalizeAttributeKey(propertyText));
			if (rule) {
				registerAlias(element.name, { rule, text: propertyText });
			}
		}
	};

	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			if (ts.isIdentifier(node.name)) {
				const binding = resolveDirectAttributeBinding(node.initializer, sourceFile);
				if (binding) {
					registerAlias(node.name, binding);
				}
			} else if (ts.isObjectBindingPattern(node.name)) {
				handleBindingPattern(node.name);
			}
		}

		if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
			handleBindingPattern(node.name);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return aliases;
}

function getBindingPropertyText(property: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)) {
		return property.text;
	}

	if (ts.isComputedPropertyName(property) && ts.isStringLiteralLike(property.expression)) {
		return property.expression.text;
	}

	return undefined;
}

function getAttributeBinding(
	expression: ts.Expression,
	sourceFile: ts.SourceFile,
	attributeAliases: AttributeAliasMap,
): AttributeBinding | undefined {
	if (ts.isIdentifier(expression)) {
		const alias = attributeAliases.get(expression.text);
		if (alias) {
			return alias;
		}
	}

	return resolveDirectAttributeBinding(expression, sourceFile);
}

function resolveDirectAttributeBinding(expression: ts.Expression, sourceFile: ts.SourceFile): AttributeBinding | undefined {
	if (ts.isPropertyAccessExpression(expression)) {
		const rule = protectedAttributeLookup.get(normalizeAttributeKey(expression.name.text));
		if (rule) {
			return { rule, text: expression.getText(sourceFile) };
		}
		return undefined;
	}

	if (ts.isElementAccessExpression(expression)) {
		const argument = expression.argumentExpression;
		if (argument && ts.isStringLiteralLike(argument)) {
			const rule = protectedAttributeLookup.get(normalizeAttributeKey(argument.text));
			if (rule) {
				return { rule, text: expression.getText(sourceFile) };
			}
		}
		return undefined;
	}

	if (ts.isIdentifier(expression)) {
		const rule = protectedAttributeLookup.get(normalizeAttributeKey(expression.text));
		if (rule) {
			return { rule, text: expression.getText(sourceFile) };
		}
	}

	return undefined;
}

function getLiteralValue(expression: ts.Expression): string | undefined {
	if (ts.isStringLiteralLike(expression)) {
		return expression.text;
	}

	if (ts.isNumericLiteral(expression)) {
		return expression.text;
	}

	switch (expression.kind) {
		case ts.SyntaxKind.TrueKeyword:
			return 'true';
		case ts.SyntaxKind.FalseKeyword:
			return 'false';
	}

	return undefined;
}

function getNumericLiteralText(expression: ts.Expression): string | undefined {
	if (ts.isNumericLiteral(expression)) {
		return expression.text;
	}

	if (
		ts.isPrefixUnaryExpression(expression) &&
		expression.operator === ts.SyntaxKind.MinusToken &&
		ts.isNumericLiteral(expression.operand)
	) {
		return `-${expression.operand.text}`;
	}

	return undefined;
}

function isEqualityOperator(kind: ts.SyntaxKind): boolean {
	switch (kind) {
		case ts.SyntaxKind.EqualsEqualsToken:
		case ts.SyntaxKind.EqualsEqualsEqualsToken:
		case ts.SyntaxKind.ExclamationEqualsToken:
		case ts.SyntaxKind.ExclamationEqualsEqualsToken:
			return true;
		default:
			return false;
	}
}

function isRangeComparisonOperator(kind: ts.SyntaxKind): boolean {
	switch (kind) {
		case ts.SyntaxKind.GreaterThanEqualsToken:
		case ts.SyntaxKind.GreaterThanToken:
		case ts.SyntaxKind.LessThanEqualsToken:
		case ts.SyntaxKind.LessThanToken:
			return true;
		default:
			return false;
	}
}

function createStructuralDiagnostic(range: vscode.Range, match: StructuralMatch): vscode.Diagnostic {
	const severity = toDiagnosticSeverity(match.rule.severity);
	const literalIsNumeric = match.literalText !== undefined && !Number.isNaN(Number(match.literalText));
	const literalDescription = match.literalText
		? literalIsNumeric
			? match.literalText
			: `"${match.literalText}"`
		: 'a hardcoded value';

	let comparisonLead: string;
	switch (match.comparisonType) {
		case 'case':
			{
				const caseLabel = match.operatorText === 'match' ? 'match case' : 'switch case';
				comparisonLead = `This ${caseLabel} routes on ${match.rule.attribute} (${match.attributeText}) when it matches ${literalDescription}`;
			}
			break;
		case 'range':
			comparisonLead = `This branch gates on ${match.rule.attribute} (${match.attributeText}) via ${match.operatorText ?? 'a comparator'} ${literalDescription}`;
			break;
		case 'membership': {
			const membershipTarget = match.literalText
				? match.literalText.includes(',')
					? `[${match.literalText}]`
					: match.literalText
				: 'the provided collection';
			const operatorDisplay = match.operatorText ?? 'in';
			comparisonLead = `This branch checks whether ${match.rule.attribute} (${match.attributeText}) is ${operatorDisplay} ${membershipTarget}`;
			break;
		}
		case 'equality':
		default:
			comparisonLead = `This branch uses ${match.operatorText ?? '=='} to compare ${match.rule.attribute} (${match.attributeText}) to ${literalDescription}`;
			break;
	}

	const messageParts = [
		`${comparisonLead}, which can encode bias against protected attributes.`,
	];

	const formattedSuggestions = formatSuggestions(match.rule.suggestions ?? []);
	if (formattedSuggestions) {
		messageParts.push(`Consider ${formattedSuggestions}.`);
	}

	messageParts.push(`Why: ${match.rule.reason}`);

	const diagnostic = new vscode.Diagnostic(range, messageParts.join(' '), severity);
	diagnostic.code = match.rule.id;
	diagnostic.source = 'bias-linter';
	return diagnostic;
}

interface DatasetMatchContext {
	moduleName?: string;
	symbolName?: string;
	matchedText: string;
	sourceType: 'import' | 'call';
}

function createDatasetDiagnostic(
	range: vscode.Range,
	rule: DatasetRule,
	context: DatasetMatchContext,
): vscode.Diagnostic {
	const severity = toDiagnosticSeverity(rule.severity);
	const locationDescription = context.sourceType === 'call' ? 'call' : 'import';
	const referenceDescription = context.symbolName
		? `"${context.symbolName}" in ${context.moduleName ?? 'this module'}`
		: context.moduleName
			? `the module "${context.moduleName}"`
			: `"${context.matchedText}"`;

	const messageParts = [
		`${locationDescription.charAt(0).toUpperCase() + locationDescription.slice(1)} ${referenceDescription} is linked to known biased data sources.`,
	];

	const formattedSuggestions = formatSuggestions(rule.suggestions ?? []);
	if (formattedSuggestions) {
		messageParts.push(`Consider ${formattedSuggestions}.`);
	}

	messageParts.push(`Why: ${rule.reason}`);

	const diagnostic = new vscode.Diagnostic(range, messageParts.join(' '), severity);
	diagnostic.code = rule.id;
	diagnostic.source = 'bias-linter';
	return diagnostic;
}

function normalizeAttributeKey(value: string): string {
	return value.replace(/_/g, '').toLowerCase();
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
