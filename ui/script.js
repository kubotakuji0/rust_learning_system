/* ---------- グローバル状態 ---------- */
let editor = null;

/* ===== 設定（DBにtop/bottomが無いときのフォールバック） ===== */
const NON_EDITABLE_TOP_LINES = 2; // 1～2行は常に固定
const FALLBACK_BOTTOM_SENTINEL = (line) => line.includes('println!'); // 保険

/* 内部状態 */
let guardsInstalled = false;
let isRestoring = false;
let lastGoodText = '';

let fixedTopText = null;     // DB から来る生文字列（null 可）
let fixedBottomText = null;  // DB から来る生文字列（null 可）

// 1始まり（両端含む）
let editableStartLine = NON_EDITABLE_TOP_LINES + 1;
let editableEndLine   = Infinity;

let decorations = [];

/* ---------- ユーティリティ ---------- */
function setStatus(kind, text) {
  const $s = document.getElementById('status');
  const cls =
    kind === 'success' ? 'badge badge-ok' :
    kind === 'danger'  ? 'badge badge-err' :
    kind === 'warn'    ? 'badge badge-warn' :
                         'badge badge-info';
  $s.className = cls;
  if (text != null) $s.textContent = text;
}

// 改行・BOM・ダブルエスケープを吸収
function decode(s) {
  if (typeof s !== 'string') return '';
  let t = s.replace(/^\uFEFF/, '');     // BOM除去
  t = t.replace(/\r\n/g, '\n');
  if (!t.includes('\n')) {
    // "\\n" で入っているケース
    t = t.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }
  return t;
}

// 行比較用に正規化（末尾空白削除・タブ→空白）
function normLine(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/\s+$/g, '');
}

// 配列 sLines の中で、subLines が連続一致する最初の開始インデックス（0始まり）を返す。無ければ -1
function findBlockTopIndex(sLines, subLines) {
  const N = sLines.length, M = subLines.length;
  if (!M) return -1;
  outer: for (let i = 0; i + M <= N; i++) {
    for (let j = 0; j < M; j++) {
      if (normLine(sLines[i + j]) !== normLine(subLines[j])) continue outer;
    }
    return i;
  }
  return -1;
}

// 配列 sLines の最後から見て、subLines が連続一致する開始インデックス（0始まり）。無ければ -1
function findBlockBottomIndex(sLines, subLines) {
  const N = sLines.length, M = subLines.length;
  if (!M) return -1;
  outer: for (let i = N - M; i >= 0; i--) {
    for (let j = 0; j < M; j++) {
      if (normLine(sLines[i + j]) !== normLine(subLines[j])) continue outer;
    }
    return i;
  }
  return -1;
}

// 現在テキストから編集可能窓を再計算
function computeEditableWindowFromText(fullText) {
  const lines = decode(fullText).split('\n');
  const total = lines.length;

  // デフォルト
  let start = Math.min(NON_EDITABLE_TOP_LINES + 1, total);
  let end   = total;

  // fixedTopText/fixedBottomText から探索
  const topLines = fixedTopText ? decode(fixedTopText).split('\n') : [];
  const botLines = fixedBottomText ? decode(fixedBottomText).split('\n') : [];

  // top
  if (topLines.length > 0) {
    const ti = findBlockTopIndex(lines, topLines);
    if (ti !== -1) start = Math.min(ti + topLines.length + 1, total);
  } else {
    // DBに無いときのフォールバック：先頭 n 行固定
    start = Math.min(NON_EDITABLE_TOP_LINES + 1, total);
  }

  // bottom
  if (botLines.length > 0) {
    const bi = findBlockBottomIndex(lines, botLines);
    if (bi !== -1) end = Math.max(1, bi); // ブロック開始の直前まで編集可
  } else {
    // フォールバック：println! を含む最初の行を下限に
    let idx = lines.findIndex(FALLBACK_BOTTOM_SENTINEL);
    if (idx === -1) idx = total; // 見つからなければ末尾まで
    end = Math.max(1, idx);      // sentinel を含む行は編集不可
  }

  if (start > end) { start = Math.min(start, total); end = start - 1; }
  editableStartLine = start;
  editableEndLine   = Math.max(end, start); // 1 行も無ければ start==end で潰さない
}

// ハイライト
function updateEditableDecoration() {
  const model = editor.getModel();
  const total = model.getLineCount();
  const start = Math.min(Math.max(editableStartLine, 1), total);
  const end   = Math.min(Math.max(editableEndLine, start), total);

  if (start > end) {
    decorations = editor.deltaDecorations(decorations, []);
    return;
  }
  decorations = editor.deltaDecorations(decorations, [{
    range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
    options: { isWholeLine: true, className: 'editable-range', inlineClassName: 'editable-range' },
  }]);
}

// そのキーが編集操作になり得るか
function isEditingKey(e) {
  const k  = e.keyCode;
  const be = e.browserEvent;

  const nav = new Set([
    monaco.KeyCode.LeftArrow, monaco.KeyCode.RightArrow,
    monaco.KeyCode.UpArrow,   monaco.KeyCode.DownArrow,
    monaco.KeyCode.Home,      monaco.KeyCode.End,
    monaco.KeyCode.PageUp,    monaco.KeyCode.PageDown
  ]);
  if (nav.has(k)) return false;

  if (e.ctrlKey || e.metaKey) {
    const combos = new Set([ monaco.KeyCode.KeyV, monaco.KeyCode.KeyX, monaco.KeyCode.KeyZ, monaco.KeyCode.KeyY ]);
    return combos.has(k);
  }
  if (e.shiftKey && k === monaco.KeyCode.Insert) return true;

  if (k === monaco.KeyCode.Backspace || k === monaco.KeyCode.Delete ||
      k === monaco.KeyCode.Enter    || k === monaco.KeyCode.Tab) return true;

  const printable = be && typeof be.key === 'string' && be.key.length === 1 &&
                    !be.ctrlKey && !be.metaKey && !be.altKey;
  return !!printable;
}

/* ---------- Monaco 初期化 ---------- */
const monacoReady = new Promise((resolve) => {
  const ver = window.MONACO_VERSION || '0.45.0';
  require.config({ paths: { vs: `https://cdn.jsdelivr.net/npm/monaco-editor@${ver}/min/vs` } });
  require(['vs/editor/editor.main'], () => {
    editor = monaco.editor.create(document.getElementById('editor'), {
      value: '',
      language: 'rust',
      theme: 'vs-dark',
      automaticLayout: true,
    });
    resolve();
  });
});

/* ---------- ガード（スナップショット復元のみ） ---------- */
function installGuardsOnce() {
  if (guardsInstalled) return;
  guardsInstalled = true;

  editor.onKeyDown((e) => {
    const pos = editor.getPosition();
    const line = pos.lineNumber;
    if ((line < editableStartLine || line > editableEndLine) && isEditingKey(e)) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (line === editableStartLine && pos.column === 1 && e.keyCode === monaco.KeyCode.Backspace) {
      e.preventDefault(); e.stopPropagation(); return;
    }
  });

  editor.onDidChangeModelContent((e) => {
    if (isRestoring) return;

    // どの差分も編集可の窓内に完全に入っているか？
    const allInside = e.changes.every(ch => {
      const s = ch.range.startLineNumber;
      const eL = ch.range.endLineNumber;
      return s >= editableStartLine && eL <= editableEndLine;
    });

    if (!allInside) {
      // 不正編集 → 丸ごと巻き戻し
      isRestoring = true;
      editor.setValue(lastGoodText);
      isRestoring = false;
      // 再計算
      computeEditableWindowFromText(lastGoodText);
      updateEditableDecoration();
      return;
    }

    // 正常編集 → スナップショット更新＆窓再計算（println! が上下しても追随）
    lastGoodText = editor.getValue();
    computeEditableWindowFromText(lastGoodText);
    updateEditableDecoration();
  });
}

/* ---------- 問題のロード＆反映 ---------- */
async function selectProblem(id) {
  await monacoReady;
  const desc = document.getElementById('problemDesc');

  try {
    const r = await fetch(`/api/problems/${id}`);
    if (!r.ok) throw new Error(`failed to fetch problem ${id}: ${r.status}`);
    const raw = await r.json();

    const starter = decode(raw.starter_code ?? raw.starterCode ?? '');
    fixedTopText    = raw.fixed_top    ?? raw.fixedTop    ?? null;
    fixedBottomText = raw.fixed_bottom ?? raw.fixedBottom ?? null;

    // フォールバック：DBになければ先頭2行/println!以降を固定
    if (!fixedTopText) {
      const ls = starter.split('\n');
      fixedTopText = ls.slice(0, NON_EDITABLE_TOP_LINES).join('\n');
    }
    if (!fixedBottomText) {
      const ls = starter.split('\n');
      let idx = ls.findIndex(FALLBACK_BOTTOM_SENTINEL);
      if (idx === -1) idx = Math.max(0, ls.length - 1);
      fixedBottomText = ls.slice(idx).join('\n');
    }

    isRestoring = true;
    editor.setValue(starter || '// 初期コードが空です。\n');
    isRestoring = false;

    lastGoodText = editor.getValue();                  // 初期スナップショット
    computeEditableWindowFromText(lastGoodText);       // 窓を決定
    updateEditableDecoration();
    installGuardsOnce();

    desc.textContent = raw.description ?? '';
    setStatus('info', `問題を読み込みました: ${raw.title}`);
  } catch (e) {
    console.error(e);
    setStatus('danger', '問題の読み込みに失敗しました');
  }
}

/* ---------- 問題一覧のロード ---------- */
async function loadProblems() {
  await monacoReady;
  const sel  = document.getElementById('problemSelect');
  const desc = document.getElementById('problemDesc');

  try {
    const res = await fetch('/api/problems');
    if (!res.ok) throw new Error('failed to fetch problems');
    const problems = await res.json();

    sel.innerHTML = '';
    for (const p of problems) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.id}: ${p.title}`;
      sel.appendChild(opt);
    }

    if (problems.length > 0) {
      await selectProblem(problems[0].id);
    } else {
      isRestoring = true; editor.setValue(''); isRestoring = false;
      lastGoodText = '';
      desc.textContent = '';
      setStatus('warn', '利用可能な問題がありません');
    }

    sel.addEventListener('change', async () => {
      const id = Number(sel.value);
      if (!Number.isNaN(id)) await selectProblem(id);
    });
  } catch (e) {
    console.error(e);
    setStatus('danger', '問題一覧の取得に失敗しました');
  }
}

/* ---------- 実行 ---------- */
async function runServer() {
  const $btnRun = document.getElementById('runBtn');
  const $output = document.getElementById('output');
  await monacoReady;

  const sel = document.getElementById('problemSelect');
  const pid = Number(sel && sel.value);
  if (!pid) { setStatus('danger', '問題が選択されていません'); return; }

  const code = editor.getValue();

  try {
    $btnRun.disabled = true;
    setStatus('info', '実行中...');

    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem_id: pid, code }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`run error: ${resp.status} ${txt}`);
    }

    const data = await resp.json();
    $output.textContent = data.output || ((data.stdout || '') + (data.stderr || ''));

    if (data.timed_out) {
      setStatus('danger', 'タイムアウト (2s)');
    } else if (!data.compiled) {
      setStatus('danger', 'コンパイルエラー');
    } else if (data.passed) {
      setStatus('success', '正解！');
    } else {
      setStatus('warn', '不正解（出力不一致）');
    }
  } catch (e) {
    console.error(e);
    setStatus('danger', 'サーバエラー');
  } finally {
    $btnRun.disabled = false;
  }
}

/* ---------- 初期化 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('runBtn');
  if (btn) btn.addEventListener('click', runServer);
  loadProblems();
});
