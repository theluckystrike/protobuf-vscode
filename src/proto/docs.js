'use strict';
// API reference from .proto files, as Markdown or as one self-contained HTML page (no scripts, no external files).
// Services with their methods (and the google.api.http route when the file has one), messages with their fields,
// enums with their values, each with the comments written above them in the .proto file.

const { optionValue, SCALARS } = require('./parser');

const anchor = (full) => full.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();

/** route of a method from option (google.api.http) = { get: "/v1/..." } */
function httpRoute(rpc) {
  const o = (rpc.options || []).find((x) => x.name === '(google.api.http)' && x.value.kind === 'aggregate');
  if (!o) return null;
  const m = /\b(get|put|post|delete|patch)\s*:\s*"([^"]*)"/.exec(o.value.text);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : null;
}

/**
 * files: [{ rel, ast }]. resolve(rel, typeName, scope) -> full name of a message or enum, or null.
 * Returns a model used by both renderers.
 */
function collect(files, resolve) {
  const out = [];
  for (const { rel, ast } of files) {
    const f = { rel, pkg: ast.package || '', syntax: ast.edition ? `edition ${ast.edition}` : ast.syntax || 'proto2', services: [], messages: [], enums: [] };
    const typeRef = (t, scope) => {
      if (SCALARS.has(t)) return { text: t };
      const full = resolve(rel, t, scope);
      return full ? { text: t.replace(/^\./, ''), full } : { text: t.replace(/^\./, '') };
    };
    const walk = (m) => {
      f.messages.push({
        full: m.fullName, name: m.fullName.slice(f.pkg ? f.pkg.length + 1 : 0), comment: m.comment,
        deprecated: optionValue(m.options, 'deprecated') === true,
        fields: m.fields.filter((x) => !x.group || true).map((x) => ({
          name: x.name, number: x.number, label: x.map ? '' : x.label || '', oneof: x.oneof,
          type: x.map ? { text: `map<${x.map.key}, ${x.map.value}>`, full: SCALARS.has(x.map.value) ? undefined : resolve(rel, x.map.value, m.fullName) } : typeRef(x.type, m.fullName),
          comment: [x.comment, x.trailing].filter(Boolean).join('\n'), deprecated: optionValue(x.options, 'deprecated') === true,
        })),
      });
      for (const e of m.enums) walkEnum(e);
      for (const c of m.messages) if (!c.isGroup || true) walk(c);
    };
    const walkEnum = (e) => f.enums.push({ full: e.fullName, name: e.fullName.slice(f.pkg ? f.pkg.length + 1 : 0), comment: e.comment, values: e.values.map((v) => ({ name: v.name, number: v.number, comment: [v.comment, v.trailing].filter(Boolean).join('\n') })) });
    for (const s of ast.services) {
      f.services.push({
        full: s.fullName, name: s.name, comment: s.comment,
        rpcs: s.rpcs.map((r) => ({ name: r.name, comment: r.comment, input: typeRef(r.input, s.fullName), output: typeRef(r.output, s.fullName), inStream: r.inputStream, outStream: r.outputStream, http: httpRoute(r), deprecated: optionValue(r.options, 'deprecated') === true })),
      });
    }
    for (const m of ast.messages) walk(m);
    for (const e of ast.enums) walkEnum(e);
    out.push(f);
  }
  return out;
}

function markdown(model, { title = 'API reference', when = new Date() } = {}) {
  const L = [];
  const link = (t) => (t.full ? `[${t.text}](#${anchor(t.full)})` : `\`${t.text}\``);
  const counts = model.reduce((a, f) => ({ s: a.s + f.services.length, m: a.m + f.messages.length, e: a.e + f.enums.length }), { s: 0, m: 0, e: 0 });
  L.push(`# ${title}`, '');
  L.push(`Generated from ${model.length} .proto file(s) on ${when.toISOString().slice(0, 10)}: ${counts.s} service(s), ${counts.m} message(s), ${counts.e} enum(s).`, '');
  L.push('## Contents', '');
  for (const f of model) {
    L.push(`- [${f.rel}](#${anchor('file-' + f.rel)})`);
    for (const s of f.services) L.push(`  - [${s.name}](#${anchor(s.full)}) (service)`);
    for (const m of f.messages) L.push(`  - [${m.name}](#${anchor(m.full)})`);
    for (const e of f.enums) L.push(`  - [${e.name}](#${anchor(e.full)}) (enum)`);
  }
  L.push('');
  for (const f of model) {
    L.push(`<a id="${anchor('file-' + f.rel)}"></a>`, '', `## ${f.rel}`, '', `Package \`${f.pkg || '(none)'}\`, ${f.syntax}.`, '');
    for (const s of f.services) {
      L.push(`<a id="${anchor(s.full)}"></a>`, '', `### ${s.name} (service)`, '');
      if (s.comment) L.push(s.comment, '');
      L.push('| Method | Request | Response | Description |', '| --- | --- | --- | --- |');
      for (const r of s.rpcs) {
        const d = [r.deprecated ? '**Deprecated.**' : '', r.http ? `\`${r.http}\`` : '', cell(r.comment)].filter(Boolean).join(' ');
        L.push(`| ${r.name} | ${r.inStream ? 'stream ' : ''}${link(r.input)} | ${r.outStream ? 'stream ' : ''}${link(r.output)} | ${d} |`);
      }
      L.push('');
    }
    for (const m of f.messages) {
      L.push(`<a id="${anchor(m.full)}"></a>`, '', `### ${m.name}`, '');
      if (m.deprecated) L.push('**Deprecated.**', '');
      if (m.comment) L.push(m.comment, '');
      if (!m.fields.length) { L.push('No fields.', ''); continue; }
      L.push('| Field | Number | Type | Label | Description |', '| --- | --- | --- | --- | --- |');
      for (const x of m.fields) {
        const d = [x.deprecated ? '**Deprecated.**' : '', x.oneof ? `Part of oneof \`${x.oneof}\`.` : '', cell(x.comment)].filter(Boolean).join(' ');
        L.push(`| ${x.name} | ${x.number} | ${link(x.type)} | ${x.label} | ${d} |`);
      }
      L.push('');
    }
    for (const e of f.enums) {
      L.push(`<a id="${anchor(e.full)}"></a>`, '', `### ${e.name} (enum)`, '');
      if (e.comment) L.push(e.comment, '');
      L.push('| Name | Number | Description |', '| --- | --- | --- |');
      for (const v of e.values) L.push(`| ${v.name} | ${v.number} | ${cell(v.comment)} |`);
      L.push('');
    }
  }
  return L.join('\n');
}

function html(model, { title = 'API reference', when = new Date() } = {}) {
  const link = (t) => (t.full ? `<a href="#${anchor(t.full)}"><code>${esc(t.text)}</code></a>` : `<code>${esc(t.text)}</code>`);
  const para = (s) => (s ? `<p class="doc">${esc(s).replace(/\n{2,}/g, '</p><p class="doc">').replace(/\n/g, ' ')}</p>` : '');
  const toc = model.map((f) => `<li><a href="#${anchor('file-' + f.rel)}">${esc(f.rel)}</a><ul>${f.services.map((s) => `<li><a href="#${anchor(s.full)}">${esc(s.name)}</a> <span class="k">service</span></li>`).join('')}${f.messages.map((m) => `<li><a href="#${anchor(m.full)}">${esc(m.name)}</a></li>`).join('')}${f.enums.map((e) => `<li><a href="#${anchor(e.full)}">${esc(e.name)}</a> <span class="k">enum</span></li>`).join('')}</ul></li>`).join('');
  const body = model.map((f) => {
    const parts = [`<section id="${anchor('file-' + f.rel)}"><h2>${esc(f.rel)}</h2><p class="meta">Package <code>${esc(f.pkg || '(none)')}</code>, ${esc(f.syntax)}</p>`];
    for (const s of f.services) {
      parts.push(`<h3 id="${anchor(s.full)}">${esc(s.name)} <span class="k">service</span></h3>${para(s.comment)}<table><thead><tr><th>Method</th><th>Request</th><th>Response</th><th>Description</th></tr></thead><tbody>${s.rpcs.map((r) => `<tr><td><code>${esc(r.name)}</code></td><td>${r.inStream ? 'stream ' : ''}${link(r.input)}</td><td>${r.outStream ? 'stream ' : ''}${link(r.output)}</td><td>${r.deprecated ? '<b>Deprecated.</b> ' : ''}${r.http ? `<code>${esc(r.http)}</code> ` : ''}${esc(r.comment || '')}</td></tr>`).join('')}</tbody></table>`);
    }
    for (const m of f.messages) {
      parts.push(`<h3 id="${anchor(m.full)}">${esc(m.name)}</h3>${m.deprecated ? '<p><b>Deprecated.</b></p>' : ''}${para(m.comment)}${m.fields.length ? `<table><thead><tr><th>Field</th><th>Number</th><th>Type</th><th>Label</th><th>Description</th></tr></thead><tbody>${m.fields.map((x) => `<tr><td><code>${esc(x.name)}</code></td><td>${x.number}</td><td>${link(x.type)}</td><td>${esc(x.label)}</td><td>${x.deprecated ? '<b>Deprecated.</b> ' : ''}${x.oneof ? `Part of oneof <code>${esc(x.oneof)}</code>. ` : ''}${esc(x.comment || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="meta">No fields.</p>'}`);
    }
    for (const e of f.enums) {
      parts.push(`<h3 id="${anchor(e.full)}">${esc(e.name)} <span class="k">enum</span></h3>${para(e.comment)}<table><thead><tr><th>Name</th><th>Number</th><th>Description</th></tr></thead><tbody>${e.values.map((v) => `<tr><td><code>${esc(v.name)}</code></td><td>${v.number}</td><td>${esc(v.comment || '')}</td></tr>`).join('')}</tbody></table>`);
    }
    parts.push('</section>');
    return parts.join('\n');
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--line:#d1d9e0;--code:#f6f8fa;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--line:#3d444d;--code:#151b23;--link:#4493f8}}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);display:flex}
nav{position:sticky;top:0;align-self:flex-start;height:100vh;overflow:auto;width:280px;flex:none;border-right:1px solid var(--line);padding:16px;box-sizing:border-box;font-size:13px}
nav ul{list-style:none;padding-left:12px;margin:2px 0}nav>ul{padding-left:0}
main{padding:24px 32px;max-width:1100px;min-width:0}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 4px;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:var(--code)}
h2{border-bottom:1px solid var(--line);padding-bottom:4px;margin-top:36px}h3{margin:22px 0 4px}.k{font-size:12px;color:var(--muted);font-weight:normal}.meta{color:var(--muted)}.doc{white-space:normal}
@media print{nav{display:none}}
</style></head>
<body><nav><b>${esc(title)}</b><ul>${toc}</ul></nav>
<main><h1>${esc(title)}</h1><p class="meta">Generated from ${model.length} .proto file(s) on ${when.toISOString().slice(0, 10)}.</p>
${body}
</main></body></html>
`;
}

module.exports = { collect, markdown, html, httpRoute, anchor };
