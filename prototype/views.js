/**
 * TestGrove — List and Stats views
 *
 * The same data as the tree, for when you need to scan rather than see.
 * Both read the app's current SCOPE (the suite, a folder or a file), so the
 * tree, the list and the stats always agree.
 *
 *   ListView   a dense, virtualised grid — every test, sortable, filterable,
 *              first error line inline; ↑/↓ moves, Enter opens, / searches.
 *   StatsView  pass rate, health by folder/file, failure clusters (tests that
 *              fail the same way), slowest and flakiest tests.
 *
 * Data from test results is untrusted text: it only ever enters the DOM
 * through textContent.
 */
(function () {
  const ROW_H = 32;
  const SEVERITY = { failing: 0, flaky: 1, skipped: 2, pending: 3, passing: 4 };
  const ORDER = ['failing', 'flaky', 'passing', 'skipped'];   // stacked bars: problems first
  const COLOR = { passing: 'var(--passing)', failing: 'var(--failing)', flaky: 'var(--flaky)', skipped: 'var(--skipped)', pending: 'var(--pending)' };

  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;                 // only for our own icon markup
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c);
    return n;
  }

  /** Rows for every test under a node. */
  function testsUnder(TG, node) {
    const out = [];
    for (const t of TG.walk(node)) {
      if (t.kind !== 'test') continue;
      const md = t.metadata || {};
      const [file] = t.path.split('::');
      const msg = md.error && md.error.message ? String(md.error.message) : '';
      out.push({
        id: t.id, name: t.name, file, status: t.status,
        folder: file.split('/').slice(-2, -1)[0] || '',
        duration: md.duration == null || t.status === 'skipped' ? null : md.duration,   // skipped never ran
        retries: md.retryCount || 0,
        error: msg.split('\n')[0], errorFull: msg, line: md.error && md.error.line, node: t,
      });
    }
    return out;
  }

  /** Same failure, different tests: normalise the first error line. */
  function signature(msg) {
    return msg.split('\n')[0]
      .replace(/"[^"]*"|'[^']*'/g, '"…"')
      .replace(/\d+(\.\d+)?/g, '#')
      .replace(/\s+/g, ' ')
      .trim().slice(0, 140) || 'Unknown error';
  }

  // ── List ─────────────────────────────────────────────────────────
  function ListView(root, ctx) {
    const st = { rows: [], view: [], sort: { key: 'status', dir: 1 }, show: new Set(['passing', 'failing', 'flaky', 'skipped', 'pending']),
                 q: '', sel: -1, scopeId: null };
    const ref = {};
    const icon = (s, z) => ctx.Leaf.legendIcon(s, z || 16);

    ref.title = h('div', { class: 'view-title' });
    ref.sub = h('div', { class: 'view-sub' });
    ref.chips = h('div', { class: 'chipset', role: 'group', 'aria-label': 'Show results' });
    ref.q = h('input', { type: 'search', placeholder: 'Filter by test, file or error', spellcheck: 'false', 'aria-label': 'Filter' });
    const search = h('label', { class: 'search', html:
      '<svg class="i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"/><path d="m10.3 10.3 3.2 3.2"/></svg>' });
    search.append(ref.q);
    const head = h('div', { class: 'view-head' }, h('div', {}, ref.title, ref.sub), h('div', { class: 'grow' }), ref.chips, search);

    const col = (key, label, cls) => h('button', { 'data-sort': key, class: cls || null, text: label });
    ref.head = h('div', { class: 'grid-head', role: 'row' },
      col('status', ''), col('name', 'Test'), col('file', 'File'), col('duration', 'Duration', 'r'), col('retries', 'Retries', 'r'), col('error', 'Error'));
    ref.spacer = h('div', { class: 'grid-spacer' });
    ref.body = h('div', { class: 'grid-body', tabindex: '0', role: 'grid', 'aria-label': 'Tests' }, ref.spacer);
    ref.empty = h('div', { class: 'empty-state', text: 'No tests match.' });
    root.replaceChildren(head, ref.head, ref.body);

    ref.head.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      const key = b.dataset.sort;
      st.sort = st.sort.key === key ? { key, dir: -st.sort.dir } : { key, dir: key === 'duration' || key === 'retries' ? -1 : 1 };
      apply();
    });
    ref.q.addEventListener('input', () => { st.q = ref.q.value.trim().toLowerCase(); apply(); });
    ref.body.addEventListener('scroll', () => requestAnimationFrame(draw));
    ref.body.addEventListener('click', (e) => {
      const r = e.target.closest('.row');
      if (r) choose(Number(r.dataset.i));
    });
    ref.body.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.row');
      if (r) ctx.openFile(st.view[Number(r.dataset.i)]);
    });
    ref.body.addEventListener('keydown', (e) => {
      const n = st.view.length;
      if (!n) return;
      const page = Math.max(1, Math.floor(ref.body.clientHeight / ROW_H) - 1);
      const to = { ArrowDown: st.sel + 1, ArrowUp: st.sel - 1, PageDown: st.sel + page, PageUp: st.sel - page, Home: 0, End: n - 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); choose(Math.max(0, Math.min(n - 1, to)), true); }
      else if (e.key === 'Enter' && st.sel >= 0) ctx.openFile(st.view[st.sel]);
    });

    function choose(i, scroll) {
      st.sel = i;
      const row = st.view[i];
      if (!row) return;
      if (scroll) {
        const top = i * ROW_H, b = ref.body;
        if (top < b.scrollTop) b.scrollTop = top;
        else if (top + ROW_H > b.scrollTop + b.clientHeight) b.scrollTop = top + ROW_H - b.clientHeight;
      }
      ctx.onSelect(row.id);
      draw();
    }

    function chips() {
      const c = { passing: 0, failing: 0, flaky: 0, skipped: 0 };
      for (const r of st.rows) if (r.status in c) c[r.status]++;
      ref.chips.replaceChildren(...['failing', 'flaky', 'passing', 'skipped'].filter((s) => c[s]).map((s) => {
        const b = h('button', { class: 'chip', 'aria-pressed': String(st.show.has(s)), title: `Show ${s}` });
        b.innerHTML = icon(s, 14);
        b.append(h('span', { class: 'n', text: String(c[s]) }), h('span', { text: s }));
        b.addEventListener('click', () => { st.show.has(s) ? st.show.delete(s) : st.show.add(s); chips(); apply(); });
        return b;
      }));
    }

    function apply() {
      const q = st.q;
      const { key, dir } = st.sort;
      const cmp = {
        status: (a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
        name: (a, b) => a.name.localeCompare(b.name),
        file: (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
        duration: (a, b) => (a.duration ?? -1) - (b.duration ?? -1),
        retries: (a, b) => a.retries - b.retries || (a.duration ?? 0) - (b.duration ?? 0),
        error: (a, b) => (b.error ? 1 : 0) - (a.error ? 1 : 0) || a.error.localeCompare(b.error),
      }[key];
      st.view = st.rows
        .filter((r) => st.show.has(r.status))
        .filter((r) => !q || r.name.toLowerCase().includes(q) || r.file.toLowerCase().includes(q) || r.errorFull.toLowerCase().includes(q))
        .sort((a, b) => dir * cmp(a, b));
      for (const b of ref.head.querySelectorAll('[data-sort]')) {
        if (b.dataset.sort === key && key !== 'status') b.setAttribute('data-dir', dir > 0 ? '↑' : '↓'); else b.removeAttribute('data-dir');
      }
      const selId = ctx.selectedId();
      st.sel = st.view.findIndex((r) => r.id === selId);
      ref.sub.textContent = `${st.view.length} of ${st.rows.length} tests` + (q ? ` matching “${ref.q.value.trim()}”` : '');
      ref.spacer.style.height = `${st.view.length * ROW_H}px`;
      if (!st.view.length) ref.spacer.replaceChildren(ref.empty); else draw();
    }

    function draw() {
      if (!st.view.length) return;
      const b = ref.body, top = b.scrollTop, hgt = b.clientHeight || 600;
      const i0 = Math.max(0, Math.floor(top / ROW_H) - 8), i1 = Math.min(st.view.length, Math.ceil((top + hgt) / ROW_H) + 8);
      const maxD = Math.max(1, ...st.view.map((r) => r.duration || 0));
      const frag = document.createDocumentFragment();
      for (let i = i0; i < i1; i++) {
        const r = st.view[i];
        const row = h('div', { class: `row is-${r.status}${i === st.sel ? ' sel' : ''}`, role: 'row', 'data-i': String(i),
          style: `transform: translateY(${i * ROW_H}px)`, title: r.errorFull ? `${r.name}\n\n${r.errorFull}` : r.name });
        const ic = h('span', { class: 'ic', html: icon(r.status, 16), title: r.status });
        const dur = h('span', { class: 'dur' });
        if (r.duration != null) {
          dur.append(h('i', { style: `width:${Math.max(2, Math.round((r.duration / maxD) * 46))}px` }), h('span', { text: ctx.fmtMs(r.duration) }));
        } else dur.append(h('span', { text: '—', style: 'color: var(--ink-4)' }));
        row.append(ic, h('span', { class: 'name', text: r.name }), h('span', { class: 'file', text: r.file }), dur,
          h('span', { class: 'ret', text: r.retries ? String(r.retries) : '' }),
          h('span', { class: 'cell-err', text: r.status === 'flaky' && !r.error ? `passed on retry ${r.retries}` : r.error }));
        frag.append(row);
      }
      ref.spacer.replaceChildren(frag);
    }

    return {
      refresh() {
        const scope = ctx.scope();
        if (st.scopeId !== scope.id) { st.scopeId = scope.id; ref.body.scrollTop = 0; }
        st.rows = testsUnder(ctx.TG, scope);
        ref.title.textContent = scope.kind === 'root' ? 'All tests' : scope.name;
        chips();
        apply();
      },
      focus() { ref.body.focus({ preventScroll: true }); },
      focusSearch() { ref.q.focus(); ref.q.select(); },
      redraw: draw,
    };
  }

  // ── Stats ────────────────────────────────────────────────────────
  function StatsView(root, ctx) {
    const sub = h('div', { class: 'view-sub' });
    const title = h('div', { class: 'view-title', text: 'Statistics' });
    const toList = h('button', { class: 'linkish', text: 'View as list →', onclick: () => ctx.setView('list') });
    const body = h('div', { class: 'stats-body' });
    root.replaceChildren(h('div', { class: 'view-head' }, h('div', {}, title, sub), h('div', { class: 'grow' }), toList), body);
    const icon = (s, z) => ctx.Leaf.legendIcon(s, z || 14);
    const tip = (el, html) => {
      el.addEventListener('pointermove', (e) => ctx.showTip(html(), e.clientX, e.clientY));
      el.addEventListener('pointerleave', ctx.hideTip);
    };

    function kpi(label, value, sub, cls, ic) {
      const v = h('div', { class: 'v' });
      if (ic) v.innerHTML = icon(ic, 18);
      v.append(h('span', { text: value }));
      return h('div', { class: `card kpi${cls ? ' ' + cls : ''}` }, h('div', { class: 'k', text: label }), v, sub ? h('div', { class: 'd', text: sub }) : null);
    }

    function legendRow() {
      const row = h('div', { class: 'legend-row' });
      for (const s of ORDER) { const sp = h('span', { html: icon(s, 13) }); sp.append(s); row.append(sp); }
      return row;
    }

    function stackOf(c, total, name) {
      const bar = h('div', { class: 'stack', role: 'img', 'aria-label': ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', ') });
      for (const s of ORDER) {
        if (!c[s]) continue;
        const seg = h('span', { style: `flex:${c[s]} 1 0; background:${COLOR[s]}` });
        tip(seg, () => `<div class="t-big">${c[s]} <span class="t-dim" style="font-weight:400">${s}</span></div>
          <div class="t-dim">${ctx.esc(name)} · ${Math.round((c[s] / total) * 100)}% of ${total}</div>`);
        bar.append(seg);
      }
      return bar;
    }

    return {
      refresh() {
        const TG = ctx.TG, scope = ctx.scope();
        const rows = testsUnder(TG, scope);
        const total = rows.length || 1;
        const c = { passing: 0, failing: 0, flaky: 0, skipped: 0, pending: 0 };
        for (const r of rows) c[r.status]++;
        const durations = rows.map((r) => r.duration).filter((d) => d != null).sort((a, b) => a - b);
        const sum = durations.reduce((a, b) => a + b, 0);
        const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null;
        title.textContent = scope.kind === 'root' ? 'Statistics' : `Statistics · ${scope.name}`;
        sub.textContent = `${rows.length} tests in ${scope.kind === 'root' ? 'the suite' : scope.path}`;

        const cards = [];
        // KPI row — one hero number
        cards.push(h('div', { class: 'kpis' },
          kpi('Pass rate', `${Math.round((c.passing / total) * 100)}%`, `${c.passing} of ${rows.length} passing`, 'hero'),
          kpi('Failing', String(c.failing), c.failing ? `${Math.round((c.failing / total) * 100)}% of tests` : 'nothing failing', '', 'failing'),
          kpi('Flaky', String(c.flaky), c.flaky ? 'passed only on retry' : 'none', '', 'flaky'),
          kpi('Skipped', String(c.skipped), c.skipped ? 'never ran' : 'none', '', 'skipped'),
          kpi('Run time', ctx.fmtMs(sum), 'sum of all tests'),
          kpi('p95 duration', ctx.fmtMs(p95), durations.length ? `slowest ${ctx.fmtMs(durations[durations.length - 1])}` : '')));

        // Health by group (folders at the root, files inside a folder)
        const groups = (scope.children || []).filter((g) => g.kind !== 'test').map((g) => {
          const gc = { passing: 0, failing: 0, flaky: 0, skipped: 0, pending: 0, total: 0 };
          for (const t of TG.walk(g)) if (t.kind === 'test') { gc[t.status]++; gc.total++; }
          return { g, c: gc };
        }).filter((x) => x.c.total)
          .sort((a, b) => (b.c.failing / b.c.total) - (a.c.failing / a.c.total) || (b.c.flaky / b.c.total) - (a.c.flaky / a.c.total) || a.g.name.localeCompare(b.g.name));
        if (groups.length) {
          const kind = groups.every((x) => x.g.kind === 'spec') ? 'file' : 'folder';
          const grid = h('div', { class: 'hbars' });
          for (const { g, c: gc } of groups) {
            const lab = h('button', { class: 'lab', text: g.name, title: `Fly into ${g.name}`, onclick: () => ctx.fly(g.id) });
            const val = h('span', { class: 'val', text: gc.failing ? `${gc.failing} failing · ${gc.total}` : `${gc.total} tests` });
            grid.append(lab, stackOf(gc, gc.total, g.name), val);
          }
          cards.push(h('div', { class: 'card span-7' },
            h('h4', {}, h('span', { text: `Health by ${kind}` }), h('span', { class: 'aside', text: 'problems first · click a name to fly in' })),
            legendRow(), grid));
        }

        // Failure clusters: tests failing the same way
        const failing = rows.filter((r) => r.status === 'failing');
        const clusters = new Map();
        for (const r of failing) {
          const k = signature(r.errorFull);
          (clusters.get(k) || clusters.set(k, []).get(k)).push(r);
        }
        const cl = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
        const clCard = h('div', { class: 'card span-5' },
          h('h4', {}, h('span', { text: 'Failure clusters' }), h('span', { class: 'aside', text: failing.length ? `${failing.length} failing · ${clusters.size} distinct` : '' })));
        if (!cl.length) clCard.append(h('div', { class: 'd', style: 'color: var(--ink-3); font-size: 12px', text: 'No failures in this scope.' }));
        for (const [sig, list] of cl) {
          const who = h('div', { class: 'who', text: list.slice(0, 3).map((r) => r.name).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '') });
          const show = h('button', { class: 'linkish', text: 'show in tree', onclick: () => ctx.showInTree(list.map((r) => r.id)) });
          const cnt = h('div', { class: 'cnt', text: String(list.length) });
          const sigEl = h('div', { class: 'sig', text: sig, title: list[0].errorFull });
          const right = h('div', { style: 'display:flex; gap:10px; align-items:baseline; min-width:0' }, sigEl);
          clCard.append(h('div', { class: 'cluster' }, cnt, right, h('div', { class: 'who', style: 'display:flex; gap:10px' },
            h('span', { style: 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1', text: who.textContent }), show)));
        }
        cards.push(clCard);

        // Slowest tests — one series: one neutral colour, value at the tip
        const slow = rows.filter((r) => r.duration != null).sort((a, b) => b.duration - a.duration).slice(0, 8);
        if (slow.length) {
          const max = slow[0].duration || 1;
          const grid = h('div', { class: 'hbars' });
          for (const r of slow) {
            const lab = h('button', { class: 'lab', text: r.name, title: r.file, onclick: () => ctx.onSelect(r.id) });
            const bar = h('div', { class: 'bar', style: `width:${Math.max(1, (r.duration / max) * 100).toFixed(1)}%` });
            tip(bar, () => `<div class="t-big">${ctx.fmtMs(r.duration)}</div><div class="t-dim">${ctx.esc(r.name)}</div><div class="t-meta">${ctx.esc(r.file)}</div>`);
            grid.append(lab, h('div', { class: 'bar-track' }, bar), h('span', { class: 'val', text: ctx.fmtMs(r.duration) }));
          }
          cards.push(h('div', { class: 'card span-6' }, h('h4', {}, h('span', { text: 'Slowest tests' }), h('span', { class: 'aside', text: 'duration of the last run' })), grid));
        }

        // Flaky tests — passed only after retrying
        const flaky = rows.filter((r) => r.status === 'flaky').sort((a, b) => b.retries - a.retries || a.name.localeCompare(b.name)).slice(0, 8);
        const flCard = h('div', { class: 'card span-6' }, h('h4', {}, h('span', { text: 'Flaky tests' }), h('span', { class: 'aside', text: 'by retries needed' })));
        if (!flaky.length) flCard.append(h('div', { style: 'color: var(--ink-3); font-size: 12px', text: 'No flaky tests in this scope.' }));
        else {
          const grid = h('div', { class: 'hbars' });
          const maxR = Math.max(...flaky.map((r) => r.retries), 1);
          for (const r of flaky) {
            const lab = h('button', { class: 'lab', text: r.name, title: r.file, onclick: () => ctx.onSelect(r.id) });
            const bar = h('div', { class: 'bar', style: `width:${((r.retries / maxR) * 100).toFixed(1)}%; background: var(--flaky)` });
            tip(bar, () => `<div class="t-big">${r.retries} ${r.retries === 1 ? 'retry' : 'retries'}</div><div class="t-dim">${ctx.esc(r.name)}</div>`);
            grid.append(lab, h('div', { class: 'bar-track' }, bar), h('span', { class: 'val', text: `${r.retries}×` }));
          }
          flCard.append(grid);
        }
        cards.push(flCard);
        body.replaceChildren(...cards);
      },
    };
  }

  window.TestGroveViews = {
    create(ctx) {
      const list = ListView(document.getElementById('view-list'), ctx);
      const stats = StatsView(document.getElementById('view-stats'), ctx);
      let current = 'tree';
      return {
        show(v) {
          current = v;
          document.getElementById('view-list').classList.toggle('open', v === 'list');
          document.getElementById('view-stats').classList.toggle('open', v === 'stats');
          if (v === 'list') { list.refresh(); setTimeout(() => list.focus(), 60); }
          if (v === 'stats') stats.refresh();
        },
        refresh() { if (current === 'list') list.refresh(); if (current === 'stats') stats.refresh(); },
        focusSearch() { if (current === 'list') list.focusSearch(); },
        get current() { return current; },
      };
    },
    testsUnder, signature,
  };
})();
