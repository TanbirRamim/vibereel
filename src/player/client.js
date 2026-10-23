/* vibereel player: render(t) is a pure function of time, so playback and frame capture agree exactly. */
(function () {
  'use strict';
  var R = JSON.parse(document.getElementById('reel-data').textContent);
  var qs = new URLSearchParams(location.search);
  var body = document.body;
  var capture = qs.has('capture');
  if (capture) body.classList.add('capture');
  if (qs.get('theme')) body.dataset.theme = qs.get('theme');
  if (qs.get('aspect')) body.dataset.aspect = qs.get('aspect');

  var AGENT = R.source === 'codex' ? 'Codex' : R.source === 'gemini' ? 'Gemini' : 'Claude';
  var AGENT_APP = R.source === 'codex' ? 'Codex' : R.source === 'gemini' ? 'Gemini CLI' : 'Claude Code';

  /* ---------- helpers ---------- */
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function easeOut(x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); }
  function easeInOut(x) { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function lerp(a, b, f) { return a + (b - a) * f; }
  function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }
  function fmtCost(c) { return '$' + (c >= 100 ? c.toFixed(0) : c.toFixed(2)); }
  function fmtClock(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
  }
  function fmtSpan(ms) {
    var m = Math.round(ms / 60000);
    if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + 's';
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function base(p) { return p.split('/').pop(); }

  var KW = /^(const|let|var|function|return|if|else|for|while|import|from|export|default|class|extends|new|this|async|await|try|catch|throw|type|interface|def|self|None|True|False|true|false|null|undefined|fn|pub|use|mut|impl|struct|enum|match|package|func|in|of|as|with|yield|lambda|not|and|or|is|elif|public|private|static|void|int|string|boolean)$/;
  var TOK = /(\/\/.*$|#(?![0-9a-fA-F]{3,8}\b).*$|\/\*.*?\*\/|<!--[\s\S]*?--!?>)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*(?:px|rem|em|ms|s|%)?\b|#[0-9a-fA-F]{3,8}\b)|([A-Za-z_$][\w$-]*)(?=\s*\()|([A-Za-z_$][\w$]*)/gm;
  function hl(line) {
    var out = '', last = 0, m;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(line))) {
      out += esc(line.slice(last, m.index));
      if (m[1]) out += '<span class="c">' + esc(m[1]) + '</span>';
      else if (m[2]) out += '<span class="q">' + esc(m[2]) + '</span>';
      else if (m[3]) out += '<span class="n">' + esc(m[3]) + '</span>';
      else if (m[4]) out += KW.test(m[4]) ? '<span class="k">' + esc(m[4]) + '</span>' : '<span class="f">' + esc(m[4]) + '</span>';
      else if (m[5]) out += KW.test(m[5]) ? '<span class="k">' + esc(m[5]) + '</span>' : esc(m[5]);
      last = TOK.lastIndex;
      if (m[0] === '') TOK.lastIndex++;
    }
    return out + esc(line.slice(last));
  }

  /* ---------- precompute ---------- */
  var scenes = R.scenes;
  var tests = [];
  scenes.forEach(function (s) { if (s.ev.kind === 'command' && s.ev.isTest) tests.push(s); });

  // diff display: collapse long unchanged runs
  function prepDiff(diff) {
    var rows = [], i, n = diff.length, ctx = 3;
    var changed = diff.map(function (d) { return d.op !== ' '; });
    var near = diff.map(function (_, i) {
      for (var k = Math.max(0, i - ctx); k <= Math.min(n - 1, i + ctx); k++) if (changed[k]) return true;
      return false;
    });
    var ln = 1, skipped = 0;
    for (i = 0; i < n; i++) {
      var d = diff[i];
      if (d.op !== '-') ln++;
      if (!near[i] && n > 14) { skipped++; continue; }
      if (skipped) { rows.push({ op: 'hunk', text: '⋯ ' + skipped + ' unchanged lines' }); skipped = 0; }
      rows.push({ op: d.op, text: d.text, no: d.op === '-' ? '' : ln - 1 });
    }
    if (skipped) rows.push({ op: 'hunk', text: '⋯ ' + skipped + ' unchanged lines' });
    if (rows.length > 90) { var more = rows.length - 88; rows = rows.slice(0, 88); rows.push({ op: 'hunk', text: '⋯ ' + more + ' more lines' }); }
    // reveal schedule: changed lines one after another, context with the next change
    var ch = rows.filter(function (r) { return r.op === '+' || r.op === '-'; }).length || 1;
    var span = Math.min(0.62, 0.18 + ch * 0.03);
    var order = [];
    rows.forEach(function (r, idx) { if (r.op === '+' || r.op === '-') order.push(idx); });
    order.forEach(function (idx, j) { rows[idx].at = 0.1 + span * (j / ch); });
    rows.forEach(function (r) { if (r.at == null) r.at = 0.06; });
    return rows;
  }
  scenes.forEach(function (s) { if (s.ev.kind === 'edit') s.rows = prepDiff(s.ev.diff); });

  // file tree
  var touchesByPath = {};
  R.touches.forEach(function (t) { (touchesByPath[t.path] = touchesByPath[t.path] || []).push(t); });
  var paths = Object.keys(touchesByPath);

  function buildTreeRows(maxRows) {
    var sorted = paths.slice().sort(function (a, b) {
      var A = a.split('/'), B = b.split('/');
      for (var i = 0; i < Math.min(A.length, B.length); i++) {
        if (A[i] === B[i]) continue;
        var ad = i < A.length - 1, bd = i < B.length - 1;
        if (ad !== bd) return ad ? -1 : 1;
        return A[i] < B[i] ? -1 : 1;
      }
      return A.length - B.length;
    });
    var rows = [], open = [];
    sorted.forEach(function (p) {
      var parts = p.split('/');
      var dirs = parts.slice(0, -1);
      var k = 0;
      while (k < open.length && open[k] === dirs[k]) k++;
      open = open.slice(0, k);
      for (; k < dirs.length; k++) { rows.push({ dir: true, name: dirs[k], depth: k }); open.push(dirs[k]); }
      rows.push({ path: p, name: parts[parts.length - 1], depth: dirs.length });
    });
    if (rows.length <= maxRows) return rows;
    // too many: flat list, edited files first
    var score = function (p) { return touchesByPath[p].some(function (t) { return t.type !== 'read'; }) ? 0 : 1; };
    var flat = paths.slice().sort(function (a, b) { return score(a) - score(b) || touchesByPath[a][0].at - touchesByPath[b][0].at; });
    var keep = flat.slice(0, maxRows - 1).map(function (p) { return { path: p, name: p.length > 30 ? '…' + p.slice(-29) : p, depth: 0 }; });
    keep.push({ more: true, name: '+ ' + (flat.length - keep.length) + ' more files' });
    return keep;
  }

  /* ---------- DOM ---------- */
  var stage = document.getElementById('stage');
  var el = {};
  function build() {
    var vertical = body.dataset.aspect === '9:16';
    var model = R.model ? '<span class="badge">' + esc(R.model) + '</span>' : '';
    stage.innerHTML =
      '<div class="win">' +
        '<div class="bar"><div class="dots"><i></i><i></i><i></i></div>' +
          '<div class="crumb"><b>' + esc(R.project) + '</b></div>' +
          '<div class="now" id="now"></div>' +
          '<span class="badge">' + AGENT_APP + '</span>' + (vertical ? '' : model) +
        '</div>' +
        '<div class="tree"><div class="label"><span>Files</span><span id="fcount"></span></div><div class="rows" id="rows"></div></div>' +
        '<div class="editor"><div class="tabs" id="tabs"></div><div id="ed"></div></div>' +
        '<div class="term"><div class="head"><div class="label">Terminal</div><div class="pill" id="pill"><i></i><span></span></div></div>' +
          '<div class="tbody"><div class="tscroll" id="tscroll"></div></div><div class="tflash" id="tflash"></div></div>' +
      '</div>' +
      '<div class="hud">' +
        '<div class="stat"><b id="h-real">0:00</b><span>real time</span></div>' +
        '<div class="stat"><b id="h-reel">0:00</b><span>replay</span></div>' +
        '<div class="stat"><b id="h-tok">0</b><span>tokens</span></div>' +
        '<div class="stat"><b id="h-cost">$0.00</b><span>est. cost</span></div>' +
        '<div class="stat"><b id="h-tools">0</b><span>tool calls</span></div>' +
        '<div class="scrub" id="scrub"><div class="rail"></div><div class="fill" id="fill"></div></div>' +
        '<div class="mark"><b>vibereel</b></div>' +
      '</div>' +
      '<div class="end" id="end"></div>';
    ['now', 'rows', 'tabs', 'ed', 'pill', 'tscroll', 'h-real', 'h-reel', 'h-tok', 'h-cost', 'h-tools', 'scrub', 'fill', 'end', 'fcount', 'tflash'].forEach(function (id) { el[id] = document.getElementById(id); });

    var maxRows = vertical ? 12 : 23;
    var tr = buildTreeRows(maxRows);
    el.rows.innerHTML = tr.map(function (r) {
      var pad = 14 + r.depth * 12;
      if (r.more) return '<div class="row more" style="padding-left:14px"><span class="nm">' + esc(r.name) + '</span></div>';
      if (r.dir) return '<div class="row dir" style="padding-left:' + pad + 'px"><span class="nm">' + esc(r.name) + '/</span></div>';
      return '<div class="row" data-p="' + esc(r.path) + '" style="padding-left:' + pad + 'px"><span class="flash"></span><span class="nm">' + esc(r.name) + '</span><span class="tag"></span></div>';
    }).join('');
    el.treeRows = Array.prototype.slice.call(el.rows.querySelectorAll('.row[data-p]'));

    // scrub ticks
    var ticks = '';
    scenes.forEach(function (s) {
      var cls = s.ev.kind === 'prompt' ? 'prompt' : s.ev.kind === 'edit' ? 'edit' : s.ev.kind === 'command' && s.ev.isTest ? s.ev.testState : '';
      if (cls) ticks += '<div class="tick ' + cls + '" style="left:' + (100 * s.start / R.duration).toFixed(2) + '%"></div>';
    });
    el.scrub.insertAdjacentHTML('beforeend', ticks);
    el.scrub.onclick = function (e) {
      var r = el.scrub.getBoundingClientRect();
      seekPlay(R.duration * clamp((e.clientX - r.left) / r.width, 0, 1));
    };
    buildEnd();
    lastEd = lastTerm = null;
    fit();
  }

  function buildEnd() {
    var st = R.stats;
    var eyebrow = [R.project, AGENT_APP, R.model].filter(Boolean).map(esc).join('  ·  ');
    var files = st.filesTouched.length;
    el.end.innerHTML =
      '<div class="eyebrow e0">' + eyebrow + '</div>' +
      '<h1 class="e1">' + esc(R.title) + '</h1>' +
      '<div class="grid">' +
        cell('e2', fmtSpan(st.durationMs) + '<em>→</em>' + Math.round(R.duration) + 's', 'of work, replayed') +
        cell('e3', String(st.toolCalls), 'tool calls') +
        cell('e4', '<span class="a">+' + st.linesAdded + '</span> <span class="d">−' + st.linesRemoved + '</span>', files + ' file' + (files === 1 ? '' : 's') + ' touched') +
        cell('e5', fmtTokens(st.tokens), 'tokens  ·  ' + fmtCost(st.costUsd) + ' est.') +
      '</div>' +
      '<div class="made e6"><span>made with <b>vibereel</b></span><span>npx vibereel</span></div>';
    function cell(c, v, l) { return '<div class="cell ' + c + '"><b>' + v + '</b><div class="lbl">' + l + '</div></div>'; }
  }

  function fit() {
    var w = body.dataset.aspect === '9:16' ? 720 : 1280, h = body.dataset.aspect === '9:16' ? 1280 : 720;
    var s = capture ? Math.min(innerWidth / w, innerHeight / h) : Math.min(innerWidth / w, innerHeight / h);
    stage.style.transform = 'scale(' + s + ')';
  }
  addEventListener('resize', fit);

  /* ---------- render ---------- */
  function sceneAt(t) {
    var idx = -1;
    for (var i = 0; i < scenes.length; i++) { if (scenes[i].start <= t) idx = i; else break; }
    return idx;
  }

  function hudAt(t) {
    var st = R.stats, n = scenes.length;
    if (!n || t >= R.endCardAt) return { real: st.durationMs, tok: st.tokens, cost: st.costUsd, tools: st.toolCalls };
    var i = Math.max(0, sceneAt(t)), a = scenes[i], b = scenes[i + 1];
    var bx = b ? { real: b.realAt, tok: b.tokens, cost: b.cost, start: b.start } : { real: st.durationMs, tok: st.tokens, cost: st.costUsd, start: R.endCardAt };
    var f = easeInOut((t - a.start) / Math.max(0.001, bx.start - a.start));
    var real = lerp(a.realAt, bx.real, f);
    var tools = 0;
    // tool calls: proportion of real time elapsed, honest enough for a counter
    tools = Math.round(st.toolCalls * (st.durationMs ? real / st.durationMs : t / R.endCardAt));
    return { real: real, tok: lerp(a.tokens, bx.tok, f), cost: lerp(a.cost, bx.cost, f), tools: tools };
  }

  var EDITOR_KINDS = { prompt: 1, thinking: 1, message: 1, edit: 1, read: 1, subagent: 1 };
  var lastEd = null, lastTerm = null;

  function nowLabel(s) {
    var e = s.ev;
    switch (e.kind) {
      case 'prompt': return 'Prompt';
      case 'thinking': return 'Planning';
      case 'edit': return (e.created ? 'Creating ' : 'Editing ') + e.path;
      case 'read': return 'Reading ' + e.path;
      case 'search': return 'Searching “' + e.query + '”';
      case 'command': return e.isTest ? 'Running tests' : '$ ' + e.command.split('\n')[0];
      case 'tool': return e.name + (e.detail ? ' · ' + e.detail : '');
      case 'message': return e.final ? 'Done' : 'Replying';
      case 'subagent': return 'Subagent · ' + e.task;
    }
    return '';
  }

  function renderEditor(t, si) {
    // the editor shows the most recent editor-type scene
    var k = si;
    while (k >= 0 && !EDITOR_KINDS[scenes[k].ev.kind]) k--;
    if (k < 0) { if (lastEd !== -1) { el.tabs.innerHTML = '<div class="tab empty">no file open</div>'; el.ed.innerHTML = ''; lastEd = -1; } return; }
    var s = scenes[k], e = s.ev;
    var lt = k === si ? t - s.start : s.dur + 10;
    var p = lt / s.dur;
    if (lastEd !== k) {
      lastEd = k;
      if (e.kind === 'edit') {
        el.tabs.innerHTML = '<div class="tab on"><span>' + esc(base(e.path)) + '</span><span class="st"><span class="a">+' + e.added + '</span> <span class="d">−' + e.removed + '</span></span></div>' +
          '<div class="crumbs">' + esc(e.path.split('/').join('  /  ')) + '</div>';
        el.ed.innerHTML = '<div class="pane"><div class="code' + (e.created ? ' created' : '') + '" id="code">' + s.rows.map(function (r) {
          var cls = r.op === '+' ? 'add' : r.op === '-' ? 'del' : r.op === 'hunk' ? 'hunk' : '';
          var sign = r.op === '+' ? '+' : r.op === '-' ? '−' : '';
          return '<div class="ln ' + cls + '"><span class="wash"></span><span class="g">' + (r.no || '') + '</span><span class="s">' + sign + '</span><span class="t">' + (r.op === 'hunk' ? esc(r.text) : hl(r.text)) + '</span></div>';
        }).join('') + '</div></div>';
      } else if (e.kind === 'read') {
        var pv = (e.preview && e.preview.length ? e.preview : ['']).slice(0, 40);
        el.tabs.innerHTML = '<div class="tab on"><span>' + esc(base(e.path)) + '</span><span class="st" style="color:var(--muted)">read</span></div><div class="crumbs">' + esc(e.path.split('/').join('  /  ')) + '</div>';
        el.ed.innerHTML = '<div class="pane"><div class="code" id="code">' + pv.map(function (l, i) {
          return '<div class="ln"><span class="g">' + (i + 1) + '</span><span class="s"></span><span class="t">' + hl(l) + '</span></div>';
        }).join('') + '</div></div>';
      } else {
        var who = e.kind === 'prompt' ? '<div class="who"><span class="av me">Y</span>You</div>'
          : '<div class="who"><span class="av">' + AGENT[0] + '</span>' + AGENT + (e.kind === 'thinking' ? ' · plan' : e.kind === 'subagent' ? ' · subagent · ' + esc(e.agent) : '') + '</div>';
        var bodyHtml;
        if (e.kind === 'thinking' && /^\s*(\d+[.)]|[-*])\s/m.test(e.text)) {
          bodyHtml = '<div class="plan" id="plan">' + e.text.split('\n').filter(function (l) { return l.trim(); }).slice(0, 8).map(function (l) {
            return '<div><span class="box"></span><span>' + esc(l.replace(/^\s*(\d+[.)]|[-*])\s*/, '')) + '</span></div>';
          }).join('') + '</div>';
        } else {
          bodyHtml = '<div class="say' + (e.kind === 'prompt' ? '' : ' reply') + '" id="say"></div>';
        }
        if (e.kind === 'subagent') {
          bodyHtml = '<div class="task"><span>' + esc(e.task) + '</span>' + (e.tools != null ? '<span class="n">' + e.tools + ' tool call' + (e.tools === 1 ? '' : 's') + '</span>' : '') + '</div>' + bodyHtml;
        }
        el.tabs.innerHTML = '<div class="tab on"><span>' + (e.kind === 'prompt' ? 'prompt' : e.kind === 'thinking' ? 'plan' : e.kind === 'subagent' ? 'subagent' : 'reply') + '</span></div>';
        el.ed.innerHTML = '<div class="talk" id="talk">' + who + bodyHtml + '</div>';
      }
    }
    var fade = easeOut(lt / 0.28);
    var host = el.ed.firstChild;
    if (host) { host.style.opacity = fade; host.style.transform = 'translateY(' + ((1 - fade) * 8).toFixed(2) + 'px)'; }

    if (e.kind === 'edit') {
      var code = document.getElementById('code');
      var lines = code.children, lastShown = 0;
      for (var i = 0; i < s.rows.length; i++) {
        var r = s.rows[i], q = clamp((p - r.at) / 0.07, 0, 1), node = lines[i];
        if (q > 0) lastShown = i;
        node.style.opacity = easeOut(q);
        node.style.transform = r.op === '+' ? 'translateX(' + ((1 - easeOut(q)) * -14).toFixed(2) + 'px)' : '';
        var w = node.firstChild;
        w.style.opacity = r.op === '+' || r.op === '-' ? (q > 0 ? clamp(1 - (p - r.at) * s.dur / 0.9, 0, 0.9) : 0) : 0;
      }
      var paneH = code.parentNode.clientHeight, lh = lines[0] ? lines[0].offsetHeight : 20;
      var want = Math.max(0, (lastShown + 5) * lh - paneH);
      var maxScroll = Math.max(0, lines.length * lh - paneH + 20);
      code.style.transform = 'translateY(' + (-Math.min(want, maxScroll)).toFixed(1) + 'px)';
    } else if (e.kind === 'read') {
      var c2 = document.getElementById('code'), ls = c2.children;
      var scanRow = Math.floor(easeInOut(p / 0.85) * Math.min(ls.length, 18));
      for (var j = 0; j < ls.length; j++) ls[j].classList.toggle('scan', k === si && j === scanRow);
    } else {
      var say = document.getElementById('say');
      if (say) {
        var text = e.text.length > 320 ? e.text.slice(0, 318) + '…' : e.text;
        var rate = e.kind === 'prompt' ? 0.72 : 0.5;
        var n = Math.round(text.length * easeInOut(clamp((p - 0.06) / rate, 0, 1)));
        var cursor = k === si && (n < text.length || Math.floor(lt * 2.2) % 2 === 0) ? '<span class="cur"></span>' : '';
        say.innerHTML = esc(text.slice(0, n)) + cursor;
      }
      var plan = document.getElementById('plan');
      if (plan) {
        var items = plan.children;
        for (var m = 0; m < items.length; m++) {
          var qq = easeOut(clamp((p - 0.08 - m * 0.09) / 0.12, 0, 1));
          items[m].style.opacity = qq; items[m].style.transform = 'translateY(' + ((1 - qq) * 6).toFixed(1) + 'px)';
        }
      }
    }
  }

  function classify(line) {
    if (/(\bfail(ed|ing|ure)?\b|\berror\b|✗|✕|×|\bFAIL\b|Traceback|AssertionError|expected .* (to|but))/i.test(line)) return ' err';
    if (/(\bpass(ed|ing)?\b|✓|✔|\bok\b|\bPASS\b|\bsuccess)/i.test(line)) return ' ok';
    return '';
  }

  function renderTerm(t, si) {
    var cmds = [];
    for (var i = 0; i <= si; i++) if (scenes[i].ev.kind === 'command') cmds.push(i);
    var cur = cmds.length && cmds[cmds.length - 1] === si ? si : -1;
    var html = '';
    var keep = cmds.slice(-4);
    keep.forEach(function (k) {
      var s = scenes[k], e = s.ev, old = k !== cur;
      var lt = old ? 1e9 : t - s.start;
      var cmd = e.command.split('\n')[0];
      var typeDur = Math.min(0.9, s.dur * 0.3);
      var typed = Math.round(cmd.length * clamp(lt / typeDur, 0, 1));
      var caret = !old && typed < cmd.length ? '<span class="cur"></span>' : '';
      html += '<div class="tl cmd' + (old ? ' old' : '') + '"><span class="p">❯</span>' + esc(cmd.slice(0, typed)) + caret + '</div>';
      var outStart = typeDur + 0.25, outSpan = s.dur * 0.42;
      var out = e.output.length > 12 ? e.output.slice(-12) : e.output;
      var shown = old ? out.length : Math.floor(out.length * clamp((lt - outStart) / outSpan, 0, 1) + (lt > outStart ? 1 : 0));
      shown = Math.min(shown, out.length);
      for (var j = 0; j < shown; j++) html += '<div class="tl' + (old ? ' old' : '') + classify(out[j]) + '">' + esc(out[j] || ' ') + '</div>';
      if (!old && lt > typeDur && shown === 0) html += '<div class="tl"><span class="cur"></span></div>';
    });
    if (!keep.length) html = '<div class="tl idle"><span class="p">❯</span>' + (Math.floor(t * 2.2) % 2 === 0 ? '<span class="cur"></span>' : '') + '</div>';
    if (html !== lastTerm) { el.tscroll.innerHTML = html; lastTerm = html; }

    // test pill
    var pill = el.pill, state = '', label = '';
    for (var q = tests.length - 1; q >= 0; q--) {
      var ts = tests[q];
      if (ts.start > t) continue;
      var lt2 = t - ts.start, done = lt2 > Math.min(0.9, ts.dur * 0.3) + 0.25 + ts.dur * 0.3;
      if (!done) { state = 'run'; label = 'running tests'; }
      else if (ts.ev.testState === 'fail') { state = 'fail'; label = 'tests failing'; }
      else { state = 'pass'; label = 'tests passing'; }
      break;
    }
    pill.className = 'pill ' + state;
    pill.lastChild.textContent = label;
    // result moment: tint the terminal and pop the pill when a test run lands
    var fl = 0, flCls = '';
    if (q >= 0 && (state === 'fail' || state === 'pass')) {
      var ts2 = tests[q], landed = ts2.start + Math.min(0.9, ts2.dur * 0.3) + 0.25 + ts2.dur * 0.3;
      var since = t - landed;
      if (since >= 0 && since < 1.4) { fl = 1 - since / 1.4; flCls = state; }
      var pop = since >= 0 && since < 0.35 ? 1 + 0.12 * Math.sin(Math.PI * since / 0.35) : 1;
      pill.style.transform = 'scale(' + pop.toFixed(3) + ')';
    }
    el.tflash.className = 'tflash ' + flCls;
    el.tflash.style.opacity = (fl * fl).toFixed(3);
  }

  function renderTree(t, si) {
    var active = si >= 0 && t < R.endCardAt && (scenes[si].ev.kind === 'edit' || scenes[si].ev.kind === 'read') ? scenes[si].ev.path : null;
    var touched = 0;
    for (var p in touchesByPath) if (touchesByPath[p][0].at <= t) touched++;
    el.fcount.textContent = touched ? touched : '';
    el.treeRows.forEach(function (row) {
      var list = touchesByPath[row.dataset.p], seen = false, changed = false, created = false, lastAt = -1;
      for (var i = 0; i < list.length; i++) {
        var x = list[i];
        if (x.at > t) continue;
        seen = true; lastAt = Math.max(lastAt, x.at);
        if (x.type === 'edit') changed = true;
        if (x.type === 'create') created = true;
      }
      row.classList.toggle('seen', seen);
      row.classList.toggle('changed', changed || created);
      row.classList.toggle('active', row.dataset.p === active);
      var tag = row.lastChild;
      var txt = created ? 'A' : changed ? 'M' : '';
      if (tag.textContent !== txt) { tag.textContent = txt; tag.className = 'tag ' + txt; }
      row.firstChild.style.opacity = lastAt >= 0 ? (0.2 * clamp(1 - (t - lastAt) / 0.9, 0, 1)).toFixed(3) : 0;
    });
  }

  function renderEnd(t) {
    var lt = t - R.endCardAt;
    var o = easeOut(lt / 0.45);
    el.end.style.opacity = lt > 0 ? o : 0;
    if (lt <= 0) return;
    for (var i = 0; i <= 6; i++) {
      var node = el.end.querySelector('.e' + i);
      if (!node) continue;
      var q = easeOut((lt - 0.15 - i * 0.09) / 0.5);
      node.style.opacity = q; node.style.transform = 'translateY(' + ((1 - q) * 12).toFixed(1) + 'px)';
    }
  }

  function render(t) {
    t = clamp(t, 0, R.duration);
    var si = sceneAt(t);
    if (si >= 0) {
      el.now.innerHTML = t < R.endCardAt ? '<span class="dot"></span>' + esc(nowLabel(scenes[si])) : '';
    }
    renderEditor(t, si);
    renderTerm(t, si);
    renderTree(t, si);
    var h = hudAt(t);
    el['h-real'].textContent = fmtClock(h.real);
    el['h-reel'].textContent = fmtClock(Math.min(t, R.endCardAt) * 1000) + (R.stats.durationMs > 60000 ? '  ·  ' + Math.round(R.stats.durationMs / 1000 / Math.max(1, R.endCardAt)) + '×' : '');
    el['h-tok'].textContent = fmtTokens(h.tok);
    el['h-cost'].textContent = fmtCost(h.cost);
    el['h-tools'].textContent = String(h.tools);
    el.fill.style.width = (100 * t / R.duration).toFixed(2) + '%';
    renderEnd(t);
  }

  /* ---------- playback ---------- */
  var playing = false, t0 = 0, tNow = 0, raf = 0;
  function frame(now) {
    tNow = (now - t0) / 1000;
    if (tNow >= R.duration) { tNow = R.duration; playing = false; }
    render(tNow);
    if (playing) raf = requestAnimationFrame(frame);
  }
  function play() { if (tNow >= R.duration) tNow = 0; playing = true; t0 = performance.now() - tNow * 1000; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); }
  function pause() { playing = false; cancelAnimationFrame(raf); }
  function seekPlay(t) { tNow = t; render(t); if (playing) play(); }

  var THEMES = ['dark', 'light', 'retro'];
  addEventListener('keydown', function (e) {
    if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') seekPlay(Math.min(R.duration, tNow + 2));
    else if (e.key === 'ArrowLeft') seekPlay(Math.max(0, tNow - 2));
    else if (e.key === 'r') { tNow = 0; play(); }
    else if (e.key === 't') { body.dataset.theme = THEMES[(THEMES.indexOf(body.dataset.theme) + 1) % 3]; render(tNow); }
    else if (e.key === 'a') { body.dataset.aspect = body.dataset.aspect === '9:16' ? '16:9' : '9:16'; build(); render(tNow); }
  });
  document.getElementById('stage').addEventListener('click', function (e) { if (!e.target.closest('#scrub')) { playing ? pause() : play(); } });

  build();
  render(0);
  window.__reel = { duration: R.duration, seek: function (t) { tNow = t; render(t); }, ready: true };
  if (!capture) setTimeout(play, 400);
})();
