import * as fs from 'fs';
import * as path from 'path';
import { renderCodeToHTML, runTwoSlash, createShikiHighlighter } from 'shiki-twoslash';
import PrismJS from 'prismjs';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-diff.js';
import 'prismjs/components/prism-typescript.js';
import 'prism-svelte';
import { escape, extract_frontmatter, transform } from './markdown.js';
import { modules } from '../../../../../../packages/kit/docs/types.js';
import { render_modules } from './modules.js';
import { parse_route_id } from '../../../../../../packages/kit/src/utils/routing.js';
import ts from 'typescript';
import MagicString from 'magic-string';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const snippet_cache = fileURLToPath(new URL('../../../../.snippets', import.meta.url));
if (!fs.existsSync(snippet_cache)) {
	fs.mkdirSync(snippet_cache, { recursive: true });
}

const languages = {
	bash: 'bash',
	env: 'bash',
	html: 'markup',
	svelte: 'svelte',
	js: 'javascript',
	css: 'css',
	diff: 'diff',
	ts: 'typescript',
	'': ''
};

const base = '../../documentation';

const type_regex = new RegExp(
	`(import\\(&apos;@sveltejs\\/kit&apos;\\)\\.)?\\b(${modules
		.map((module) => module.types)
		.flat()
		.map((type) => type.name)
		.join('|')})\\b`,
	'g'
);

const type_links = new Map();

modules.forEach((module) => {
	const slug = slugify(module.name);

	module.types.forEach((type) => {
		const link = `/docs/types#${slug}-${slugify(type.name)}`;
		type_links.set(type.name, link);
	});
});

/**
 * @param {string} file
 */
export async function read_file(file) {
	const match = /\d{2}-(.+)\.md/.exec(file.split(path.sep).pop());
	if (!match) return null;

	const markdown = fs
		.readFileSync(`${base}/${file}`, 'utf-8')
		.replace('**TYPES**', () => render_modules('types'))
		.replace('**EXPORTS**', () => render_modules('exports'));

	const highlighter = await createShikiHighlighter({ theme: 'css-variables' });

	const { metadata, body } = extract_frontmatter(markdown);

	const { content, sections } = parse({
		body: generate_ts_from_js(body),
		file,
		code: (source, language, current) => {
			const hash = createHash('sha256');
			hash.update(source + language + current);
			const digest = hash.digest().toString('base64').replace(/\//g, '-');

			if (fs.existsSync(`${snippet_cache}/${digest}.html`)) {
				return fs.readFileSync(`${snippet_cache}/${digest}.html`, 'utf-8');
			}

			/** @type {Record<string, string>} */
			const options = {};

			let html = '';

			source = source
				.replace(/^\/\/\/ (.+?): (.+)\n/gm, (match, key, value) => {
					options[key] = value;
					return '';
				})
				.replace(/^([\-\+])?((?:    )+)/gm, (match, prefix = '', spaces) => {
					if (prefix && language !== 'diff') return match;

					// for no good reason at all, marked replaces tabs with spaces
					let tabs = '';
					for (let i = 0; i < spaces.length; i += 4) {
						tabs += '  ';
					}
					return prefix + tabs;
				})
				.replace(/\*\\\//g, '*/');

			let version_class = '';
			if (language === 'generated-ts' || language === 'generated-svelte') {
				language = language.replace('generated-', '');
				version_class = ' ts-version';
			} else if (language === 'original-js' || language === 'original-svelte') {
				language = language.replace('original-', '');
				version_class = ' js-version';
			}

			if (language === 'js' || language === 'ts') {
				try {
					const injected = [];
					if (source.includes('$app/')) {
						injected.push(
							`// @filename: ambient-kit.d.ts`,
							`/// <reference types="@sveltejs/kit" />`
						);
					}
					if (source.includes('./$types') && !source.includes('@filename: $types.d.ts')) {
						const params = parse_route_id(options.file || `+page.${language}`)
							.names.map((name) => `${name}: string`)
							.join(', ');

						injected.push(
							`// @filename: $types.d.ts`,
							`import type * as Kit from '@sveltejs/kit';`,
							`export type PageLoad = Kit.Load<{${params}}>;`,
							`export type PageServerLoad = Kit.ServerLoad<{${params}}>;`,
							`export type LayoutLoad = Kit.Load<{${params}}>;`,
							`export type LayoutServerLoad = Kit.ServerLoad<{${params}}>;`,
							`export type RequestHandler = Kit.RequestHandler<{${params}}>;`,
							`export type Action = Kit.Action<{${params}}>;`,
							`export type Actions = Kit.Actions<{${params}}>;`
						);
					}
					if (!options.file) {
						// No named file -> assume that the code is not meant to be type checked
						// If we don't do this, twoslash would throw errors for e.g. some snippets in `types/ambient.d.ts`
						injected.push('// @noErrors');
					}
					if (injected.length) {
						const injected_str = injected.join('\n');
						if (source.includes('// @filename:')) {
							source = source.replace('// @filename:', `${injected_str}\n\n// @filename:`);
						} else {
							source = source.replace(
								/^(?!\/\/ @)/m,
								`${injected_str}\n\n// @filename: index.${language}\n// ---cut---\n`
							);
						}
					}

					const twoslash = runTwoSlash(source, language, {
						defaultCompilerOptions: {
							allowJs: true,
							checkJs: true,
							target: 'es2021'
						}
					});

					html = renderCodeToHTML(
						twoslash.code,
						'ts',
						{ twoslash: true },
						{},
						highlighter,
						twoslash
					);
				} catch (e) {
					console.error(`Error compiling snippet in ${file}`);
					console.error(e.code);
					throw e;
				}

				// we need to be able to inject the LSP attributes as HTML, not text, so we
				// turn &lt; into &amp;lt;
				html = html.replace(
					/<data-lsp lsp='([^']*)'([^>]*)>(\w+)<\/data-lsp>/g,
					(match, lsp, attrs, name) => {
						if (!lsp) return name;
						return `<data-lsp lsp='${lsp.replace(/&/g, '&amp;')}'${attrs}>${name}</data-lsp>`;
					}
				);

				// preserve blank lines in output (maybe there's a more correct way to do this?)
				html = html.replace(/<div class='line'><\/div>/g, '<div class="line"> </div>');
			} else if (language === 'diff') {
				const lines = source.split('\n').map((content) => {
					let type = null;
					if (/^[\+\-]/.test(content)) {
						type = content[0] === '+' ? 'inserted' : 'deleted';
						content = content.slice(1);
					}

					return {
						type,
						content: escape(content)
					};
				});

				html = `<pre class="language-diff"><code>${lines
					.map((line) => {
						if (line.type) return `<span class="${line.type}">${line.content}\n</span>`;
						return line.content + '\n';
					})
					.join('')}</code></pre>`;
			} else {
				const plang = languages[language];
				const highlighted = plang
					? PrismJS.highlight(source, PrismJS.languages[plang], language)
					: source.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

				html = `<pre class='language-${plang}'><code>${highlighted}</code></pre>`;
			}

			html = `<div class="code-block${version_class}">${
				options.file ? `<h5>${options.file}</h5>` : ''
			}${html}</div>`;

			type_regex.lastIndex = 0;

			html = html
				.replace(type_regex, (match, prefix, name) => {
					if (options.link === 'false' || name === current) {
						// we don't want e.g. RequestHandler to link to RequestHandler
						return match;
					}

					const link = `<a href="${type_links.get(name)}">${name}</a>`;
					return `${prefix || ''}${link}`;
				})
				.replace(
					/^(\s+)<span class="token comment">([\s\S]+?)<\/span>\n/gm,
					(match, intro_whitespace, content) => {
						// we use some CSS trickery to make comments break onto multiple lines while preserving indentation
						const lines = (intro_whitespace + content).split('\n');
						return lines
							.map((line) => {
								const match = /^(\s*)(.*)/.exec(line);
								const indent = (match[1] ?? '').replace(/\t/g, '  ').length;

								return `<span class="token comment wrapped" style="--indent: ${indent}ch">${
									line ?? ''
								}</span>`;
							})
							.join('');
					}
				);

			fs.writeFileSync(`${snippet_cache}/${digest}.html`, html);
			return html;
		},
		codespan: (text) => {
			return (
				'<code>' +
				text.replace(type_regex, (match, prefix, name) => {
					const link = `<a href="${type_links.get(name)}">${name}</a>`;
					return `${prefix || ''}${link}`;
				}) +
				'</code>'
			);
		}
	});

	return {
		file,
		slug: match[1],
		title: metadata.title,
		content,
		sections
	};
}

/**
 * @param {{
 *   body: string;
 *   file: string;
 *   code: (source: string, language: string, current: string) => string;
 *   codespan: (source: string) => string;
 * }} opts
 */
function parse({ body, file, code, codespan }) {
	const headings = [];

	/** @type {import('./types').Section[]} */
	const sections = [];

	/** @type {import('./types').Section} */
	let section;

	// this is a bit hacky, but it allows us to prevent type declarations
	// from linking to themselves
	let current = '';

	/** @type {string} */
	const content = transform(body, {
		/**
		 * @param {string} html
		 * @param {number} level
		 */
		heading(html, level) {
			const title = html
				.replace(/<\/?code>/g, '')
				.replace(/&quot;/g, '"')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>');

			current = title;

			const normalized = slugify(title);

			headings[level - 1] = normalized;
			headings.length = level;

			const slug = headings.filter(Boolean).join('-');

			if (level === 3) {
				section = {
					title,
					slug,
					sections: []
				};

				sections.push(section);
			} else if (level === 4) {
				section.sections.push({
					title,
					slug
				});
			} else {
				throw new Error(`Unexpected <h${level}> in ${file}`);
			}

			return `<h${level} id="${slug}">${html}<a href="#${slug}" class="anchor"><span class="visually-hidden">permalink</span></a></h${level}>`;
		},
		code: (source, language) => code(source, language, current),
		codespan
	});

	return {
		sections,
		content
	};
}

/** @param {string} title */
export function slugify(title) {
	return title
		.toLowerCase()
		.replace(/&lt;/g, '')
		.replace(/&gt;/g, '')
		.replace(/[^a-z0-9-$]/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-/, '')
		.replace(/-$/, '');
}

/**
 * Appends a JS->TS / Svelte->Svelte-TS code block after each JS/Svelte code block.
 * The language is `generated-js`/`generated-svelte` which can be used to detect this in later steps.
 * @param {string} markdown
 */
export function generate_ts_from_js(markdown) {
	return markdown
		.replaceAll(/```js\n([\s\S]+?)\n```/g, (match, code) => {
			if (!code.includes('/// file:')) {
				// No named file -> assume that the code is not meant to be shown in two versions
				return match;
			}

			const ts = convert_to_ts(code);

			if (!ts) {
				// No changes -> don't show TS version
				return match;
			}

			return match.replace('js', 'original-js') + '\n```generated-ts\n' + ts + '\n```';
		})
		.replaceAll(/```svelte\n([\s\S]+?)\n```/g, (match, code) => {
			if (!code.includes('/// file:')) {
				// No named file -> assume that the code is not meant to be shown in two versions
				return match;
			}

			// Assumption: no context="module" blocks
			const script = code.match(/<script>([\s\S]+?)<\/script>/);
			if (!script) return match;

			const [outer, inner] = script;
			const ts = convert_to_ts(inner, '\t', '\n');

			if (!ts) {
				// No changes -> don't show TS version
				return match;
			}

			return (
				match.replace('svelte', 'original-svelte') +
				'\n```generated-svelte\n' +
				code.replace(outer, `<script lang="ts">${ts}</script>`) +
				'\n```'
			);
		});
}

/**
 * Transforms a JS code block into a TS code block by turning JSDoc into type annotations.
 * Due to pragmatism only the cases currently used in the docs are implemented.
 * @param {string} js_code
 * @param {string} [indent]
 * @param {string} [offset]
 *  */
function convert_to_ts(js_code, indent = '', offset = '') {
	js_code = js_code
		.replaceAll('// @filename: index.js', '// @filename: index.ts')
		.replace(/(\/\/\/ .+?\.)js/, '$1ts')
		// *\/ appears in some JsDoc comments in d.ts files due to the JSDoc-in-JSDoc problem
		.replace(/\*\\\//g, '*/');

	const ast = ts.createSourceFile(
		'filename.ts',
		js_code,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const code = new MagicString(js_code);
	const imports = new Map();

	function walk(node) {
		// @ts-ignore
		if (node.jsDoc) {
			// @ts-ignore
			for (const comment of node.jsDoc) {
				let modified = false;

				for (const tag of comment.tags ?? []) {
					if (ts.isJSDocTypeTag(tag)) {
						const name = get_type_name(tag);

						if (ts.isFunctionDeclaration(node)) {
							const is_export = node.modifiers?.some(
								(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
							)
								? 'export '
								: '';
							const is_async = node.modifiers?.some(
								(modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword
							);
							code.overwrite(
								node.getStart(),
								node.name.getEnd(),
								`${is_export ? 'export ' : ''}const ${node.name.getText()}: ${name} = ${
									is_async ? 'async ' : ''
								}`
							);
							code.appendLeft(node.body.getStart(), '=> ');

							modified = true;
						} else if (
							ts.isVariableStatement(node) &&
							node.declarationList.declarations.length === 1
						) {
							code.appendLeft(node.declarationList.declarations[0].name.getEnd(), `: ${name}`);

							modified = true;
						} else {
							throw new Error('Unhandled @type JsDoc->TS conversion: ' + js_code);
						}
					} else if (ts.isJSDocParameterTag(tag) && ts.isFunctionDeclaration(node)) {
						if (node.parameters.length !== 1) {
							throw new Error(
								'Unhandled @type JsDoc->TS conversion; needs more params logic: ' + node.getText()
							);
						}
						const name = get_type_name(tag);
						code.appendLeft(node.parameters[0].getEnd(), `: ${name}`);

						modified = true;
					}
				}

				if (modified) {
					code.overwrite(comment.getStart(), comment.getEnd(), '');
				}
			}
		}

		ts.forEachChild(node, walk);
	}

	walk(ast);

	if (imports.size) {
		const import_statements = Array.from(imports.entries())
			.map(([from, names]) => {
				return `${indent}import type { ${Array.from(names).join(', ')} } from '${from}';`;
			})
			.join('\n');
		const idxOfLastImport = [...ast.statements]
			.reverse()
			.find((statement) => ts.isImportDeclaration(statement))
			?.getEnd();
		const insertion_point = Math.max(
			idxOfLastImport ? idxOfLastImport + 1 : 0,
			js_code.includes('---cut---')
				? js_code.indexOf('\n', js_code.indexOf('---cut---')) + 1
				: js_code.includes('/// file:')
				? js_code.indexOf('\n', js_code.indexOf('/// file:')) + 1
				: 0
		);
		code.appendLeft(insertion_point, offset + import_statements + '\n');
	}

	const transformed = code.toString();
	return transformed === js_code ? undefined : transformed.replace(/\n\s*\n\s*\n/g, '\n\n');

	/** @param {ts.JSDocTypeTag | ts.JSDocParameterTag} tag */
	function get_type_name(tag) {
		const type_text = tag.typeExpression.getText();
		let name = type_text.slice(1, -1); // remove { }

		const import_match = /import\('(.+?)'\)\.(\w+)/.exec(type_text);
		if (import_match) {
			const [, from, _name] = import_match;
			name = _name;
			const existing = imports.get(from);
			if (existing) {
				existing.add(name);
			} else {
				imports.set(from, new Set([name]));
			}
		}
		return name;
	}
}
