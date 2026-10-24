import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(resolve(root, 'requirements/agentweave-landing.json'), 'utf8'));
const html = await readFile(resolve(root, fixture.page), 'utf8');
const workflow = await readFile(resolve(root, fixture.deployment.workflow), 'utf8');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const occurrences = (pattern) => [...html.matchAll(pattern)].length;

check(/^<!doctype html>/i.test(html), 'Page must use the HTML5 doctype.');
check(/<html\s+lang="en"/.test(html), 'Document language must be English.');
check(html.includes(`document.documentElement.lang=locale`), 'Locale changes must update the document language.');
check(occurrences(/<h1(?:\s|>)/g) === 1, 'Page must contain exactly one h1.');
check(/<a class="skip" href="#main"[^>]*>/.test(html), 'Page must provide a skip link to main.');
check(/<main id="main">/.test(html), 'Page must contain the skip-link target main.');
check(/<nav[^>]+aria-label=/.test(html), 'Primary navigation must have an accessible name.');
check(/:focus-visible/.test(html), 'Keyboard focus must be visibly styled.');
check(/prefers-reduced-motion/.test(html), 'Reduced-motion preferences must be respected.');
check(/<meta name="viewport"/.test(html), 'Responsive viewport metadata is required.');
check(!/<(?:script|link)\b[^>]+(?:src|href)=/i.test(html), 'Runtime scripts and stylesheets must be inline.');
check(!/<(?:img|source|video|audio|iframe|object|embed)\b[^>]+(?:src|srcset|data)=/i.test(html), 'Media and embedded assets must be inline.');
const externalUrls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^\"]+)"/gi)].map((match) => match[1]);
check(externalUrls.every((url) => url === fixture.product.canonicalRepository), 'Every external link and call to action must use the canonical repository URL.');
check(/<style>[\s\S]*<\/style>/.test(html), 'Page must embed its CSS.');
check(/<script>[\s\S]*<\/script>/.test(html), 'Page must embed its JavaScript.');
check(/<svg\b/.test(html), 'Page must embed SVG artwork.');
check(/\.site-header\{position:sticky/.test(html), 'Navigation must be sticky.');
check(/class="menu-toggle"[^>]+aria-expanded="false"[^>]+aria-controls="primary-nav"/.test(html), 'Mobile navigation needs an accessible toggle.');
check(/event\.key==='Escape'/.test(html), 'Mobile navigation must close with Escape.');
check((html.match(/<ol class="flow-list"[\s\S]*?<\/ol>/)?.[0].match(/<li>/g) || []).length === 7, 'Collaboration flow must contain seven stages.');
const flowHtml = html.match(/<ol class="flow-list"[\s\S]*?<\/ol>/)?.[0] ?? '';
const flowTitles = [...flowHtml.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
check(JSON.stringify(flowTitles) === JSON.stringify(fixture.collaborationStages), 'Collaboration stages must match the fixture-defined order.');
check(html.includes(`applyLocale('${fixture.localization.defaultLocale}')`), 'Page must initialize the fixture default locale.');
check(html.includes('document.title=translate(\'meta.title\')'), 'Locale changes must update the document title.');
check(html.includes('meta[name="description"]'), 'Locale changes must update the description metadata.');
check(/data-locale="en"[^>]+aria-pressed="true"/.test(html), 'English must be the initially selected locale.');
check(/data-locale="zh-Hans"[^>]+aria-pressed="false"/.test(html), 'Simplified Chinese must be an available locale.');

const dictionaryMatch = html.match(/const messages=(\{[\s\S]*?\n    \});/);
if (!dictionaryMatch) {
  failures.push('Matched localization dictionaries are required.');
} else {
  const dictionaries = Function(`"use strict";return (${dictionaryMatch[1]})`)();
  const locales = Object.keys(dictionaries).sort();
  check(JSON.stringify(locales) === JSON.stringify([...fixture.languages].sort()), 'Dictionary locales must match the requirements fixture.');
  const expectedKeys = [...new Set([
    ...html.matchAll(/data-i18n="([^"]+)"/g),
    ...html.matchAll(/data-i18n-aria-label="([^"]+)"/g)
  ].map((match) => match[1]).concat(fixture.localization.metadataKeys, fixture.localization.dynamicKeys))].sort();
  for (const locale of fixture.languages) {
    const keys = Object.keys(dictionaries[locale] ?? {}).sort();
    check(expectedKeys.every((key) => keys.includes(key)), `${locale} dictionary must cover all localized content, accessibility labels, and metadata.`);
    check(keys.every((key) => typeof dictionaries[locale][key] === 'string' && dictionaries[locale][key].trim()), `${locale} dictionary values must be non-empty strings.`);
  }
}
for (const marker of ['id="proof"', 'id="runtime"', 'Human direction', 'Agent teamwork', 'class="wrap closing"']) check(html.includes(marker), `Missing landing-page marker: ${marker}`);
for (const proof of fixture.proofValues) check(html.includes(proof), `Missing approved proof value: ${proof}`);
for (const feature of fixture.runtimeFeatures) {
  check(html.includes(feature.title) && html.includes(feature.description), `Missing approved runtime feature: ${feature.title}`);
}
for (const forbidden of fixture.forbiddenClaims) check(!html.toLowerCase().includes(forbidden.toLowerCase()), `Forbidden invented product claim remains: ${forbidden}`);
check(html.includes('Apache 2.0'), 'The page must include the approved Apache 2.0 license reference.');
try { await access(resolve(root, 'index.html')); failures.push('Root index.html must not exist; docs/index.html is the sole source.'); } catch {}

for (const id of fixture.requiredSections) check(new RegExp(`(?:id="${id}"|<${id}\\b)`).test(html), `Missing required section: ${id}`);
for (const copy of fixture.requiredCopy) check(html.includes(copy), `Missing required copy: ${copy}`);
for (const link of fixture.requiredLinks) check(html.includes(`href="${link}"`), `Missing canonical link: ${link}`);
for (const fact of fixture.verifiedFacts) {
  check(typeof fact.claim === 'string' && fact.claim.length > 20, 'Every fact needs a meaningful claim.');
  check(typeof fact.pageText === 'string' && html.includes(fact.pageText), `Sourced fact is not represented on the page: ${fact.claim}`);
  check(fact.source === 'original product brief', `Fact must be grounded in the original product brief: ${fact.claim}`);
}
check(workflow.includes('actions/configure-pages@v5'), 'Pages workflow must configure GitHub Pages.');
check(workflow.includes('actions/upload-pages-artifact@v3'), 'Pages workflow must upload an artifact.');
check(workflow.includes('actions/deploy-pages@v4'), 'Pages workflow must deploy the artifact.');
check(/path:\s*docs/.test(workflow), 'Pages artifact must be sourced from docs/.');
await access(resolve(root, 'docs/.nojekyll'));

if (failures.length) {
  console.error(`Documentation validation failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation validation passed: ${fixture.requiredCopy.length} copy checks, ${fixture.verifiedFacts.length} sourced facts, accessibility and Pages deployment.`);
}
