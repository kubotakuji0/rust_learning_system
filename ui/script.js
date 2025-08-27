// ▼ 追加：問題IDをURLクエリ ?id=q01 から取得（無ければ q01）
function getProblemIdFromURL() {
  const p = new URLSearchParams(location.search).get('id');
  return p || 'q01';
}

// ▼ 追加：問題をAPIから取得
async function fetchProblem(id) {
  const res = await fetch(`/api/problems/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('問題を取得できませんでした');
  return await res.json(); // ProblemDto
}

//Monacoの読み込み（問題を取得してから初期化）
require(['vs/editor/editor.main'], async function () {
  const problemId = getProblemIdFromURL();
  const p = await fetchProblem(problemId);

  // 問題文をDOMに反映
  document.querySelector('.panel-title').textContent = '問題';
  document.querySelector('.desc').innerHTML = p.prompt_html;

  // 初期コードと判定条件（DB由来）
  const originalCode = p.starter_code;
  const TOP_LOCK_LINES = p.top_lock_lines;
  const EDIT_START    = TOP_LOCK_LINES + 1;
  const EXPECTED_OUT  = p.expected_stdout;
  const BOTTOM_ANCHOR = p.bottom_anchor;

  const lines = originalCode.replace(/\r\n/g, '\n').split('\n');
  const fixedTop = lines.slice(0,TOP_LOCK_LINES);
  let endIndex = lines.findIndex(l => l.includes(BOTTOM_ANCHOR));
  if (endIndex === -1) endIndex = lines.length - 1; // 保険
  const fixedBottom = lines.slice(endIndex); // println! を含む行〜末尾

  //Monacoエディタ生成
  const editor = monaco.editor.create(document.getElementById('editor'), {
    value: originalCode,
    language: 'rust',
    theme: 'vs-dark',
    automaticLayout: true,
  });
  const model = editor.getModel();

  // 編集可能範囲のハイライト
  let decorations = [];
  function bottomStartLine() { // 1始まりの println! 行
    const cur = model.getLinesContent();
    return (cur.length - fixedBottom.length + 1);
  }

  function updateEditableDecoration() {
    const endLine = Math.max(EDIT_START, bottomStartLine() - 1);
    decorations = editor.deltaDecorations(decorations, [{
      range: new monaco.Range(EDIT_START, 1, endLine, 1),
      options: { isWholeLine: true, className: 'editable-range', inlineClassName: 'editable-range' },
    }]);
  }
  
  updateEditableDecoration();

  function isEditingKey(e) {
    const k  = e.keyCode;
    const be = e.browserEvent;

    //ナビゲーションキー
    const nav = new Set([
      monaco.KeyCode.LeftArrow,
      monaco.KeyCode.RightArrow,
      monaco.KeyCode.UpArrow,
      monaco.KeyCode.DownArrow,
      monaco.KeyCode.Home,
      monaco.KeyCode.End,
      monaco.KeyCode.PageUp,
      monaco.KeyCode.PageDown
    ]);
    if (nav.has(k)) return false;

    if (e.ctrlKey || e.metaKey) {
    // 編集のショートカット
    const editingCombos = new Set([
      monaco.KeyCode.KeyV, // Paste
      monaco.KeyCode.KeyX, // Cut
      monaco.KeyCode.KeyZ, // Undo
      monaco.KeyCode.KeyY, // Redo
    ]);
    if (editingCombos.has(k)) return true;
    return false;
    }
    //Shift+Insert
    if (e.shiftKey && k === monaco.KeyCode.Insert) return true;
    // 単体で編集になるキー
    if (k === monaco.KeyCode.Backspace || k === monaco.KeyCode.Delete ||
        k === monaco.KeyCode.Enter    || k === monaco.KeyCode.Tab) return true;

    // 実際に1文字が入力される場合だけ true
    const printable = be && typeof be.key === 'string' &&
                      be.key.length === 1 &&
                      !be.ctrlKey && !be.metaKey && !be.altKey;
    return !!printable;
  }

  editor.onKeyDown(function (e) {
    const pos    = editor.getPosition();
    const line   = pos.lineNumber;
    const column = pos.column;
    const bottomLine = bottomStartLine();
    //上２行で編集キー
    if (line <= TOP_LOCK_LINES && isEditingKey(e)) {
      e.preventDefault(); e.stopPropagation();
      return;
    }
    //３行目左端でバックスペースキー
    if (line === EDIT_START && column === 1 && e.keyCode === monaco.KeyCode.Backspace) {
      e.preventDefault(); e.stopPropagation();
      return;
    }
    //下部の編集不可領域での編集キー
    if (line >= bottomLine && isEditingKey(e)) {
      e.preventDefault(); e.stopPropagation();
      return;
    }
  });

  editor.onDidChangeModelContent(function () {
    const cur   = model.getLinesContent();
    const edits = [];

    //上側の復旧
    for (let i = 0; i < fixedTop.length; i++) {
      if (cur[i] !== fixedTop[i]) {
        const r = new monaco.Range(i + 1, 1, i + 1, model.getLineMaxColumn(i + 1));
        edits.push({ range: r, text: fixedTop[i], forceMoveMarkers: true });
      }
    }

    //下側の復旧
    const offset = cur.length - fixedBottom.length;
    for (let i = 0; i < fixedBottom.length; i++) {
      const idx = offset + i;
      if (cur[idx] !== fixedBottom[i]) {
        const range = new monaco.Range(idx + 1, 1, idx + 1, model.getLineMaxColumn(idx + 1));
        edits.push({ range, text: fixedBottom[i], forceMoveMarkers: true });
      }
    }
  //編集可能列の保護
  const bottomLine = bottomStartLine(); // println! を含む行（1始まり）
  const editableLines = Math.max(0, bottomLine - EDIT_START);
  const lacking = 1 - editableLines;
  if (lacking > 0) {
    // 3行目の先頭に空行を必要数だけ差し込む
    const insertAt = new monaco.Range(EDIT_START, 1, EDIT_START, 1);
    edits.push({ range: insertAt, text: '\n'.repeat(lacking), forceMoveMarkers: true });
  }

    if (edits.length) {
      editor.executeEdits(null, edits);
    }
    updateEditableDecoration();
  });

  // UI 要素
  const $btnRun  = document.getElementById('runBtn');
  const $btnReset= document.getElementById('resetBtn');
  const $status  = document.getElementById('status');
  const $output  = document.getElementById('output');

  function setStatus(kind, text) { // kind: 'ok'|'warn'|'err'|'info'
  const map = { ok:'badge badge-ok', warn:'badge badge-warn', err:'badge badge-err', info:'badge badge-info' };
  $status.className = map[kind] || map.info;
  $status.textContent = text;
}

  function normalizeOut(s) { return (s ?? '').replace(/\r\n/g, '\n'); }

  function showResult(resp) {
    // サーバ優先の combined 出力（fallback は手元結合）
    const combined = resp.output ?? ((resp.stdout ?? '') + (resp.stderr ?? ''));
    const out = normalizeOut(combined);

    $output.textContent = (out || '(empty)');

    if (!resp.compiled) { setStatus('err', 'コンパイルエラー'); return; }
    if (resp.timed_out) { setStatus('err', 'タイムアウト');   return; }

    const stdoutOnly = normalizeOut(resp.stdout ?? '');
    const okOut = stdoutOnly ? (stdoutOnly === EXPECTED_OUT) : (out === EXPECTED_OUT);

    if (!okOut) {
      setStatus('warn', '出力不一致');
    } else if (!resp.used_add_world) {
      setStatus('warn', 'add_world未使用');
    } else {
      setStatus('ok', '正解！');
    }
  }

  async function runServer() {
    try {
      setStatus('info', '実行中…');
      $btnRun.disabled = true;
      const code = editor.getValue();
      const resp = await fetch('/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem_id: problemId, code })
      });
      const json = await resp.json();
      showResult(json);
    } catch (e) {
      setStatus('err', '通信エラー: ' + (e && e.message ? e.message : e));
    } finally {
      $btnRun.disabled = false;
    }
  }

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runServer());
  $btnRun.addEventListener('click', () => runServer());
  $btnReset.addEventListener('click', () => {
    if (confirm('コードをリセットしますか？')) {
      editor.setValue(originalCode);
      setStatus('info', 'リセットしました');
      $output.textContent = 'ここに出力が表示されます';
    }
  });
});