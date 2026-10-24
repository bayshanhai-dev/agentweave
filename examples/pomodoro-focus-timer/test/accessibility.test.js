import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

test('landing page uses semantic landmarks and a logical heading structure', () => {
  assert.match(html, /<header\b/);
  assert.match(html, /<nav[^>]+aria-label=/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /<footer\b/);
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(html, /<section id="why" aria-labelledby="why-title">/);
  assert.match(html, /<section id="how" aria-labelledby="how-title">/);
  assert.match(html, /<section id="runtime" aria-labelledby="runtime-title">/);
  assert.match(html, /<section id="install" aria-labelledby="install-title">/);
});

test('navigation is keyboard accessible and mobile ready', () => {
  assert.match(html, /<a class="skip" href="#main"[^>]*>/);
  assert.match(html, /\.site-header\{position:sticky/);
  assert.match(html, /<button class="menu-toggle"[^>]+aria-expanded="false"[^>]+aria-controls="primary-nav"/);
  assert.match(html, /menuButton\.setAttribute\('aria-expanded'/);
  assert.match(html, /event\.key==='Escape'/);
  assert.match(html, /menuButton\.focus\(\)/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /@media\(max-width:700px\)/);
  assert.match(html, /prefers-reduced-motion:reduce/);
});

test('locale control updates content, metadata, language, and selected state without reload', () => {
  assert.match(html, /class="locale-control" role="group"[^>]+data-i18n-aria-label="locale.label"/);
  assert.match(html, /data-locale="en" aria-pressed="true"/);
  assert.match(html, /data-locale="zh-Hans" aria-pressed="false"/);
  assert.match(html, /document\.documentElement\.lang=locale/);
  assert.match(html, /document\.title=translate\('meta.title'\)/);
  assert.match(html, /meta\[name="description"\]/);
  assert.match(html, /button\.setAttribute\('aria-pressed'/);
  assert.match(html, /applyLocale\('en'\)/);
  assert.doesNotMatch(html, /location\.(?:reload|replace)/);
});

test('developer-tooling visual system is resilient and accessible', () => {
  assert.match(html, /--bg:#070912/);
  assert.match(html, /--indigo:#7c83ff/);
  assert.match(html, /--cyan:#55ddf6/);
  assert.match(html, /backdrop-filter:blur/);
  assert.match(html, /@supports not \(\(backdrop-filter:blur/);
  assert.match(html, /\.hero>\* ,.section-head>\*/);
  assert.match(html, /@media\(max-width:1080px\)/);
  assert.match(html, /body:before\{animation:none\}/);
  assert.match(html, /<svg[^>]+aria-hidden="true"/);
  assert.match(html, /role="img" aria-label="AgentWeave control-plane summary/);
});

test('required landing-page content is complete and self-contained', () => {
  assert.match(html, /id="proof"/);
  assert.match(html, /class="runtime-grid"/);
  assert.match(html, /Human direction/);
  assert.match(html, /Agent teamwork/);
  assert.match(html, /class="wrap closing"/);
  const flow = html.match(/<ol class="flow-list"[\s\S]*?<\/ol>/)?.[0] || '';
  assert.equal((flow.match(/<li>/g) || []).length, 7);
  assert.match(html, /<style>[\s\S]*<\/style>/);
  assert.match(html, /<script>[\s\S]*<\/script>/);
  assert.match(html, /<svg\b/);
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]+(?:src|href)=/i);
});

test('docs is the only maintained website source', () => {
  assert.equal(fs.existsSync(new URL('../index.html', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../docs/index.html', import.meta.url)), true);
});
