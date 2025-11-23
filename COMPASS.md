🧭 Project Compass: The "Bias Linter"
1. Project Identity
Name: Bias Linter (VS Code Extension) Tagline: "An ESLint for Ethics." Goal: To operationalize Algorithmic Bias detection by flagging potential ethical issues in code as the developer types, rather than in a post-hoc audit.

2. The Core Problem & Solution
The Problem: Current tools (like vscode-alex or woke) only check for Syntax (insensitive terminology in comments/strings). They fail to detect Semantics (biased logic flows or dangerous datasets).

The Solution: A real-time linter that uses AST (Abstract Syntax Tree) Analysis to understand the intent of the code, not just the words.

3. Technical Architecture
Platform: Visual Studio Code Extension.

Language: TypeScript.

Core Mechanism:

NO External LLM Calls: For the detection loop, we must use local parsing for <50ms latency.

AST Parsing: We will use the TypeScript Compiler API or acorn to parse code into trees.

Diagnostic Collection: We use vscode.languages.createDiagnosticCollection to render red/yellow squigglies.

Local Context: A lightweight JSON database containing "Reasoning" (e.g., summaries of academic papers like Moral Machine) to display in the hover tooltip.

4. The 3 Levels of Detection (Implementation Roadmap)
We are building these three distinct layers. Copilot should be aware of which layer we are working on.

Level 1: Terminology (The Baseline)
Logic: Simple Regex/String matching within Identifier nodes.

Target: Master/Slave, Whitelist/Blacklist.

Fix: Suggest "Allowlist/Blocklist".

Level 2: Structural Logic (The USP)
Logic: AST Traversal looking for control flow patterns (IfStatement, SwitchCase).

Target: Hardcoded logic on protected attributes.

Example: if (user.gender == 'female')

Warning: "This branch logic relies on a binary definition of gender, potentially causing allocative harm."

Level 3: Supply Chain (The Data Audit)
Logic: Inspect ImportDeclaration nodes.

Target: Known biased datasets (e.g., from sklearn.datasets import load_boston).

Warning: "The Boston Housing dataset is deprecated due to racial bias variables. Reference: [Harrison & Rubinfeld, 1978]."

5. Development Constraints & Values
Privacy First: No code leaves the user's machine.

Educational: Every warning must provide a "Why." We aren't scolding the user; we are nudging them (Nudge Theory).

Latency: The linter must feel instant. Heavy processing goes to a background worker.

6. Context for Code Generation
Target Audience: Students and developers learning about Algorithmic Bias (Syllabus: Session 8).

Style: Clean, modular TypeScript. Use strict typing.

License: MIT License.